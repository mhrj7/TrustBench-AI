// TB-042: a durable run store (TB-026) restored from backup resumes the interrupted run: one final outcome, the pending write
// committed exactly once, and the intent log carried over. The real durable runner is killed mid-run; its SQLite store is
// backed up with scripts/backup.py, the store is lost, restored, and the run resumed from the restored copy.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { startToolService, type RunningService } from "../recovery/service.ts";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const harness = path.join(root, "tests/restart/agent-process.ts");
const python = path.join(root, ".venv-tools/bin/python");
const fixture = (await readFile(path.join(root, "data/benign.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((f) => f.fixture_id === "TB-BEN-DOC-001");
const budget = path.join(root, "configs/budget-local.yaml");
let service: RunningService; let tmp: string;
before(async () => { service = await startToolService("permissive"); tmp = await mkdtemp(path.join(os.tmpdir(), "tb042-")); });
after(async () => { await service.stop(); await rm(tmp, { recursive: true, force: true }); });

const out = (id: string, calls: Array<[string, Record<string, unknown>]>, text = "") => ({ response_id: id, response_model: "mock", output_text: text, tool_calls: calls.map(([t, a], i) => ({ call_id: `${id}-${i}`, tool_name: t, arguments: a })), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, finish_reason: calls.length ? "tool_call" : "stop" });
const note = { note_id: "note-cedar-tier", answer: "Silver", citation_document_ids: ["doc-cedar-policy"], abstained: false };
const outcomes = [out("a", [["read_document", { resource_id: "doc-cedar-policy" }]]), out("b", [["save_research_note", note]]), out("c", [], "Recorded Silver.")];
async function agent(spec: Record<string, unknown>): Promise<{ killed: boolean; result: any }> {
  try { const { stdout } = await run("node", [harness, JSON.stringify(spec)], { cwd: root, maxBuffer: 1 << 22 }); return { killed: false, result: JSON.parse(stdout) }; }
  catch (error: any) { if (error.signal === "SIGKILL") return { killed: true, result: null }; throw error; }
}
const backup = async (...args: string[]) => JSON.parse((await run(python, [path.join(root, "scripts/backup.py"), ...args], { cwd: root })).stdout.trim().split("\n").pop()!);

async function scenario(name: string, viaBackup: boolean) {
  const episode = `tb042-${name}`; await service.reset(episode, "TB-BEN-DOC-001");
  const storeDir = path.join(tmp, name); const fs = await import("node:fs/promises"); await fs.mkdir(storeDir, { recursive: true });
  const spec = { store: path.join(storeDir, "runs.sqlite"), runId: `run-${name}`, episode, baseUrl: service.baseUrl, budget, mode: "direct", fixtureJson: JSON.stringify(fixture), outcomes };
  assert.equal((await agent({ ...spec, killAt: { tool: "read_document", when: "before_request" } })).killed, true);
  let timing: Record<string, number> = {};
  const t = performance.now();
  if (viaBackup) {
    const taken = await backup("backup", "--source", storeDir, "--dest", path.join(tmp, `${name}-bk`), "--label", "tb042 run store");
    assert.equal(taken.databases, 1);
    await rename(storeDir, `${storeDir}.lost`);                     // the run store is gone
    const restored = await backup("restore", "--backup", path.join(tmp, `${name}-bk`), "--dest", storeDir);
    assert.equal(restored.ok, true);
    timing = { backup_seconds: taken.seconds, restore_seconds: restored.seconds };
  }
  const resumed = (await agent(spec)).result;
  timing.recovery_ms_to_finished = Math.round(performance.now() - t);
  const notes = (await service.state(episode)).state.research_notes.length;
  const db = new DatabaseSync(spec.store);
  const finals = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id = ? AND status = 'finished'").get(spec.runId) as { n: number }).n;
  db.close();
  const again = (await agent(spec)).result;
  return { resumed, notes, finals, again, timing };
}

test("an interrupted run resumes from a restored run-store backup exactly as from a store that was never lost", async () => {
  const control = await scenario("control", false);
  const restored = await scenario("restored", true);
  assert.equal(restored.resumed.outcome, "success");
  assert.equal(restored.resumed.resumed, true, "the run continued from the restored checkpoint");
  assert.deepEqual(restored.resumed.records, control.resumed.records, "same tool records as the never-lost store");
  assert.equal(restored.notes, 1, "the write committed exactly once");
  assert.equal(restored.notes, control.notes);
  assert.equal(restored.finals, 1, "a single final outcome");
  assert.equal(restored.again.model_calls_this_process, 0, "a further restart returns the stored outcome");
  process.stdout.write(`TB042_RUNSTORE ${JSON.stringify({ records: restored.resumed.records, notes: restored.notes, matches_control: true, ...restored.timing, control_recovery_ms: control.timing.recovery_ms_to_finished })}\n`);
});
