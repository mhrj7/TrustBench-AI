// TB-040 drill: a damaged or altered run checkpoint is never resumed. The real durable runner (tests/restart/agent-process.ts)
// is killed mid-run, its SQLite checkpoint is then corrupted on disk in several ways, and the resumed process must end with
// an explicit checkpoint_corrupt failure, run no tool, and leave the episode state untouched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { CHECKPOINT_CORRUPT } from "../../src/agent/run-store.ts";
import { startToolService, type RunningService } from "../recovery/service.ts";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const harness = path.join(root, "tests/restart/agent-process.ts");
const fixture = (await readFile(path.join(root, "data/benign.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((f) => f.fixture_id === "TB-BEN-DOC-001");
const budget = path.join(root, "configs/budget-local.yaml");
let service: RunningService; let tmp: string;
before(async () => { service = await startToolService("permissive"); tmp = await mkdtemp(path.join(os.tmpdir(), "tb040-")); });
after(async () => { await service.stop(); await rm(tmp, { recursive: true, force: true }); });

const out = (id: string, calls: Array<[string, Record<string, unknown>]>, text = "") => ({ response_id: id, response_model: "mock", output_text: text, tool_calls: calls.map(([t, a], i) => ({ call_id: `${id}-${i}`, tool_name: t, arguments: a })), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, finish_reason: calls.length ? "tool_call" : "stop" });
const note = { note_id: "note-cedar-tier", answer: "Silver", citation_document_ids: ["doc-cedar-policy"], abstained: false };
const outcomes = [out("a", [["read_document", { resource_id: "doc-cedar-policy" }]]), out("b", [["save_research_note", note]]), out("c", [], "Recorded Silver.")];
async function agent(spec: Record<string, unknown>): Promise<{ killed: boolean; result: any }> {
  try { const { stdout } = await run("node", [harness, JSON.stringify(spec)], { cwd: root, maxBuffer: 1 << 22 }); return { killed: false, result: JSON.parse(stdout) }; }
  catch (error: any) { if (error.signal === "SIGKILL") return { killed: true, result: null }; throw error; }
}
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

type Tamper = (db: DatabaseSync, runId: string) => void;
const cases: Array<[string, Tamper]> = [
  ["an injected tool call (checkpoint edited, checksum left stale)", (db, id) => {
    const row = db.prepare("SELECT checkpoint_json FROM runs WHERE run_id = ?").get(id) as { checkpoint_json: string };
    const cp = JSON.parse(row.checkpoint_json);
    cp.pending_calls = [{ call_id: "injected", tool_name: "save_research_note", arguments: { ...note, answer: "Gold" } }];
    db.prepare("UPDATE runs SET checkpoint_json = ? WHERE run_id = ?").run(JSON.stringify(cp), id);
  }],
  ["a truncated checkpoint (torn write; checksum matches the bytes)", (db, id) => {
    const row = db.prepare("SELECT checkpoint_json FROM runs WHERE run_id = ?").get(id) as { checkpoint_json: string };
    const torn = row.checkpoint_json.slice(0, Math.floor(row.checkpoint_json.length / 2));
    db.prepare("UPDATE runs SET checkpoint_json = ?, checkpoint_sha256 = ? WHERE run_id = ?").run(torn, sha(torn), id);
  }],
  ["a checkpoint with its checksum removed", (db, id) => { db.prepare("UPDATE runs SET checkpoint_sha256 = NULL WHERE run_id = ?").run(id); }],
];

for (const [label, tamper] of cases) {
  test(`a resumed run refuses ${label}`, async () => {
    const slug = label.replace(/[^a-z]+/g, "-").slice(0, 30);
    const episode = `tb040-${slug}`; await service.reset(episode, "TB-BEN-DOC-001");
    const spec = { store: path.join(tmp, `${slug}.sqlite`), runId: `run-${slug}`, episode, baseUrl: service.baseUrl, budget, mode: "direct", fixtureJson: JSON.stringify(fixture), outcomes };
    assert.equal((await agent({ ...spec, killAt: { tool: "save_research_note", when: "before_request" } })).killed, true);
    const before = (await service.state(episode)).state;
    const db = new DatabaseSync(spec.store); tamper(db, spec.runId); db.close();
    const resumed = (await agent(spec)).result;
    assert.equal(resumed.outcome, "failure");
    assert.equal(resumed.records.length, 0, "no tool ran from the damaged checkpoint");
    assert.equal(resumed.model_calls_this_process, 0, "nothing was re-generated either");
    const after = (await service.state(episode)).state;
    assert.deepEqual(after.research_notes, before.research_notes);
    assert.equal(after.research_notes.length, 0);
    const check = new DatabaseSync(spec.store);
    const final = JSON.parse((check.prepare("SELECT final_json FROM runs WHERE run_id = ?").get(spec.runId) as { final_json: string }).final_json);
    check.close();
    assert.ok(final.failures.some((f: { code: string }) => f.code === CHECKPOINT_CORRUPT), "the stored outcome names the corruption explicitly");
    assert.equal((await agent(spec)).result.outcome, "failure", "the failure is final; a further restart does not retry the damaged state");
  });
}

test("an altered final outcome is reported corrupt instead of being returned or re-run", async () => {
  const episode = "tb040-final"; await service.reset(episode, "TB-BEN-DOC-001");
  const spec = { store: path.join(tmp, "final.sqlite"), runId: "run-final", episode, baseUrl: service.baseUrl, budget, mode: "direct", fixtureJson: JSON.stringify(fixture), outcomes };
  assert.equal((await agent(spec)).result.outcome, "success");
  const db = new DatabaseSync(spec.store);
  const row = db.prepare("SELECT final_json FROM runs WHERE run_id = ?").get(spec.runId) as { final_json: string };
  db.prepare("UPDATE runs SET final_json = ? WHERE run_id = ?").run(row.final_json.replace('"success"', '"cancelled"'), spec.runId); db.close();
  const again = (await agent(spec)).result;
  assert.equal(again.outcome, "failure");
  assert.equal(again.model_calls_this_process, 0);
  assert.equal((await service.state(episode)).state.research_notes.length, 1, "the original single effect stands; nothing is repeated");
});
