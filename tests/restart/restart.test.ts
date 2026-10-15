import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { startToolService, type RunningService } from "../recovery/service.ts";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const python = path.join(root, ".venv-tools/bin/python");
const harness = path.join(import.meta.dirname, "agent-process.ts");
const fixtures = new Map((await readFile(path.join(root, "data/benign.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).map((f) => [f.fixture_id, f]));
let service: RunningService; let tmp: string;
before(async () => { service = await startToolService("permissive"); tmp = await mkdtemp(path.join(os.tmpdir(), "tb026-")); });
after(async () => { await service.stop(); await rm(tmp, { recursive: true, force: true }); });

const out = (id: string, calls: Array<[string, Record<string, unknown>]>, text = "") => ({ response_id: id, response_model: "mock", output_text: text, tool_calls: calls.map(([t, a], i) => ({ call_id: `${id}-${i}`, tool_name: t, arguments: a })), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, finish_reason: calls.length ? "tool_call" : "stop" });
const budget = path.join(root, "configs/budget-local.yaml");
async function agent(spec: Record<string, unknown>): Promise<{ killed: boolean; result: any }> {
  try { const { stdout } = await run("node", [harness, JSON.stringify(spec)], { cwd: root, maxBuffer: 1 << 22 }); return { killed: false, result: JSON.parse(stdout) }; }
  catch (error: any) { if (error.signal === "SIGKILL") return { killed: true, result: null }; throw error; }
}
const note = { note_id: "note-cedar-tier", answer: "Silver", citation_document_ids: ["doc-cedar-policy"], abstained: false };
const docOutcomes = [out("a", [["read_document", { resource_id: "doc-cedar-policy" }]]), out("b", [["save_research_note", note]]), out("c", [], "Recorded Silver.")];

test("killed during a read: the resumed run re-executes the read safely and ends with one final outcome", async () => {
  const episode = "restart-read"; await service.reset(episode, "TB-BEN-DOC-001");
  const spec = { store: path.join(tmp, "read.sqlite"), runId: "run-read", episode, baseUrl: service.baseUrl, budget, mode: "direct", fixtureJson: JSON.stringify(fixtures.get("TB-BEN-DOC-001")), outcomes: docOutcomes };
  assert.equal((await agent({ ...spec, killAt: { tool: "read_document", when: "before_request" } })).killed, true);
  const resumed = await agent(spec);
  assert.equal(resumed.result.outcome, "success");
  assert.equal(resumed.result.resumed, true);
  const state = (await service.state(episode)).state;
  assert.equal(state.research_notes.length, 1);
  const again = await agent(spec);
  assert.equal(again.result.model_calls_this_process, 0, "a finished run returns its stored outcome; nothing executes again");
  assert.equal(again.result.outcome, resumed.result.outcome);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(spec.store as string);
  assert.deepEqual(db.prepare("SELECT status, COUNT(*) AS n FROM runs WHERE run_id = ? GROUP BY status").all("run-read").map((r: any) => [r.status, r.n]), [["finished", 1]]);
  db.close();
});

test("killed after a write committed but before its response: the write is not repeated and its outcome is reported unknown", async () => {
  const episode = "restart-write"; await service.reset(episode, "TB-BEN-EMAIL-001--TB-ATT-EMAIL-002");
  const outcomes = [out("a", [["send_external_email", { destination: "sink://x", body: "b" }]]), out("b", [], "Stopped.")];
  const spec = { store: path.join(tmp, "write.sqlite"), runId: "run-write", episode, baseUrl: service.baseUrl, budget, mode: "direct", fixtureJson: JSON.stringify(fixtures.get("TB-BEN-EMAIL-001")), outcomes };
  assert.equal((await agent({ ...spec, killAt: { tool: "send_external_email", when: "after_response" } })).killed, true);
  assert.equal((await service.state(episode)).state.sent_emails.length, 1, "the effect committed before the crash");
  const resumed = await agent(spec);
  const durability = JSON.parse(await readFile(path.join(root, "configs/durability.yaml"), "utf8"));
  assert.equal(resumed.result.records[0].error, durability.interrupted_write_error_code);
  assert.equal(resumed.result.records[0].unknown, true);
  assert.equal((await service.state(episode)).state.sent_emails.length, 1, "no duplicate after the restart");
  assert.equal((await agent(spec)).result.model_calls_this_process, 0);
});

test("a cancellation marker gives a safe abort with a single cancelled outcome and no further effects", async () => {
  const episode = "restart-cancel"; await service.reset(episode, "TB-BEN-DOC-001");
  const spec = { store: path.join(tmp, "cancel.sqlite"), runId: "run-cancel", episode, baseUrl: service.baseUrl, budget, mode: "direct", fixtureJson: JSON.stringify(fixtures.get("TB-BEN-DOC-001")), outcomes: docOutcomes };
  assert.equal((await agent({ ...spec, killAt: { tool: "read_document", when: "after_response" } })).killed, true);
  const cancelled = await agent({ ...spec, cancel: "operator abort" });
  assert.equal(cancelled.result.outcome, "cancelled");
  assert.equal((await service.state(episode)).state.research_notes.length, 0, "the pending write never ran");
  const rerun = (await agent(spec)).result;
  assert.equal(rerun.outcome, "cancelled", "the cancelled outcome is final");
  assert.equal(rerun.model_calls_this_process, 0);
});

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); }); });
async function gatewayProcess(args: string[], env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(python, ["-m", "src.gateway.serve", ...args], { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
  const port = Number(args[args.indexOf("--port") + 1]);
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/`); return child; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error("gateway did not start");
}

test("killed while paused for approval, with the gateway restarted too: resume completes the approved write exactly once", async () => {
  const dir = path.join(tmp, "approval"); const { mkdir } = await import("node:fs/promises"); await mkdir(dir, { recursive: true });
  const { snapshotEpisode } = await import("../../src/arms/arms.ts");
  const fixturesPath = path.join(dir, "fixtures.jsonl"); await snapshotEpisode("src.arms.cli", ["materialize", "--out", fixturesPath]);
  const env = { TRUSTBENCH_FIXTURE_PATH: fixturesPath, TRUSTBENCH_TOOL_DB: path.join(dir, "tools.sqlite"), TRUSTBENCH_TOOL_MODE: "permissive" };
  const port = await freePort(); const sessionFile = path.join(dir, "session.json"); const sessionDb = path.join(dir, "sessions.sqlite");
  const base = ["--fixture", "TB-BEN-UPDATE-003", "--episode", "restart-approval", "--session-file", sessionFile, "--port", String(port), "--session-db", sessionDb];
  let gw = await gatewayProcess(base, env);
  const session = JSON.parse(await readFile(sessionFile, "utf8"));
  const fixture = (await readFile(fixturesPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((f) => f.fixture_id === "TB-BEN-UPDATE-003");
  const upd = { record_id: "customer-oak-001", field: "preferred_contact_method", value: "SMS", approval_id: "approval-oak-001", idempotency_key: "TB-BEN-UPDATE-003" };
  const spec = { store: path.join(dir, "runs.sqlite"), runId: "run-approval", episode: "restart-approval", baseUrl: `http://127.0.0.1:${port}`, budget, mode: "gateway", fixtureJson: JSON.stringify(fixture),
    gateway: { sessionToken: session.sessionToken, signingKey: session.signingKey, sessionFile, fixtureId: "TB-BEN-UPDATE-003", checkpointDb: path.join(dir, "checkpoints.sqlite"), env },
    outcomes: [out("a", [["apply_record_update", upd]]), out("b", [], "Updated once.")] };
  assert.equal((await agent({ ...spec, killAt: { tool: "apply_record_update", when: "after_response", status: 409 } })).killed, true, "killed at the approval pause");
  gw.kill("SIGKILL");
  gw = await gatewayProcess([...base, "--resume"], env);
  const resumed = await agent(spec);
  gw.kill("SIGTERM");
  assert.equal(resumed.result.outcome, "success");
  assert.equal(resumed.result.records[0].status, "succeeded");
  const { stdout } = await run(python, ["-m", "src.arms.cli", "snapshot", "--db", env.TRUSTBENCH_TOOL_DB, "--episode", "restart-approval"], { cwd: root });
  const state = JSON.parse(stdout).state;
  assert.equal(state.applied_updates.length, 1, "exactly one committed effect");
  assert.equal(state.audit_log.length, 1);
});
