import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createTracing, Redactor, sensitiveValues } from "../src/observability/tracing.ts";
import { RunSpans } from "../src/observability/run-spans.ts";
import { checkSpans } from "../src/observability/check.ts";

const secrets = sensitiveValues();
const canary = secrets.find((s) => s.includes("CANARY"))!;

async function traced(fn: (spans: RunSpans) => Promise<void>, runId = "run-x:defended") {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "tb027-")), "spans.jsonl");
  const tracing = createTracing(file, "test");
  const spans = new RunSpans(tracing.tracer, { "run.id": runId, arm: "defended", "case.id": "c" });
  await fn(spans);
  await tracing.provider.forceFlush();
  return { text: await readFile(file, "utf8"), redactor: tracing.redactor };
}

test("sensitive values come from the data files and include the planted canaries", () => {
  assert.ok(canary, "the seeded canary marker is in the registered sensitive set");
  assert.ok(secrets.some((s) => s.includes("SALARY-LEDGER")));
});

test("model, tool and policy spans all link to their run, and queueing is recorded", async () => {
  const { text } = await traced(async (spans) => {
    const response = { usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop", tool_calls: [] };
    await spans.model("agent", "req-1", () => new Promise((r) => setTimeout(r, 25)), async () => response);
    const tools = spans.tools({ read_document: { execute: async () => ({ output: { content: `secret ${canary}` }, stateChangeIds: [] }) } }, { read: ["read_document"], write: [] });
    await tools.read_document!.execute({ resource_id: "d" }, { runId: "r", taskId: "t", callId: "call-1", signal: new AbortController().signal });
    spans.policy([{ seq: 0, tool: "read_document", decision: "allow", executed: true, started_at_ms: Date.now(), policy_ms: 1.5, backend_ms: 3 }]);
    spans.end({ "run.outcome": "success" }, 0);
  });
  const { problems, stats } = checkSpans(text);
  assert.deepEqual(problems, []);
  assert.equal(stats.runs, 1);
  assert.deepEqual([stats.model_spans, stats.tool_spans, stats.retrieval_spans, stats.policy_spans], [1, 1, 1, 1]);
  const model = text.trim().split("\n").map((l) => JSON.parse(l)).find((s) => s.name === "model.call");
  assert.ok(model.attributes["queue.ms"] >= 20, "the pacing wait is recorded as queue time");
  assert.ok(!text.includes(canary), "tool output never reaches a span");
});

test("an unpaced model call is never labelled as provider pacing, however long it takes to resume (TB-051)", async () => {
  const { text } = await traced(async (spans) => {
    const response = { usage: { input_tokens: 5, output_tokens: 2 }, finish_reason: "stop", tool_calls: [] };
    const busy = Date.now() + 5; while (Date.now() < busy) { /* a loaded machine: the call itself starts late */ }
    await spans.model("agent", "unpaced", null, async () => { const t = Date.now() + 3; while (Date.now() < t) {} return response; });
    await spans.model("agent", "paced", () => new Promise((r) => setTimeout(r, 5)), async () => response);
    spans.end({ "run.outcome": "success" }, 0);
  });
  const calls = text.trim().split("\n").map((l) => JSON.parse(l)).filter((s) => s.name === "model.call");
  const by = (id: string) => calls.find((s) => s.attributes["model.request_id"] === id);
  assert.equal(by("unpaced").attributes["queue.reason"], undefined);
  assert.equal(by("paced").attributes["queue.reason"], "provider_pacing");
});

test("a canary that reaches an exported attribute is redacted, and unknown attributes are dropped", async () => {
  const { text, redactor } = await traced(async (spans) => {
    const tools = spans.tools({ lookup_contact: { execute: async () => { throw Object.assign(new Error("x"), { code: `leak-${canary}` }); } } }, { read: ["lookup_contact"], write: [] });
    await tools.lookup_contact!.execute({}, { runId: "r", taskId: "t", callId: "c1", signal: new AbortController().signal }).catch(() => {});
    spans.end({ "run.outcome": "failure", "secret.payload": canary } as any, 0);
  });
  assert.ok(!text.includes(canary));
  assert.ok(text.includes("[REDACTED]"));
  assert.ok(redactor.replaced >= 1 && redactor.dropped.get("secret.payload") === 1);
  assert.deepEqual(checkSpans(text).problems, []);
});

test("the checker rejects leaked canaries, wrong run ids, orphan spans and missing roots", () => {
  const span = (o: Record<string, unknown>) => JSON.stringify({ trace_id: "t1", span_id: "s", parent_span_id: null, name: "agent.run", attributes: { "run.id": "r1" }, ...o });
  const rootLine = span({ span_id: "root" });
  assert.match(checkSpans([rootLine, span({ span_id: "a", parent_span_id: "root", name: "tool.call", attributes: { "run.id": "r1", "tool.error_code": canary } })].join("\n")).problems.join(" "), /sensitive fixture value/);
  assert.match(checkSpans([rootLine, span({ span_id: "b", parent_span_id: "root", name: "tool.call", attributes: { "run.id": "r2" } })].join("\n")).problems.join(" "), /has run.id r2/);
  assert.match(checkSpans([rootLine, span({ span_id: "c", parent_span_id: "elsewhere", name: "tool.call" })].join("\n")).problems.join(" "), /parent outside its trace/);
  assert.match(checkSpans(span({ span_id: "d", parent_span_id: "x", name: "tool.call" })).problems.join(" "), /root spans/);
  assert.match(checkSpans([rootLine, span({ span_id: "e", parent_span_id: "root", name: "model.call", attributes: { "run.id": "r1" } })].join("\n")).problems.join(" "), /no queue timing/);
  assert.match(checkSpans([rootLine, span({ span_id: "f", parent_span_id: "root", name: "tool.call", attributes: { "run.id": "r1", "raw.output": "x" } })].join("\n")).problems.join(" "), /non-allowlisted/);
});

test("the redactor replaces every occurrence and longer values first", () => {
  const r = new Redactor(new Set(["k"]), ["abc-123456", "abc-123456-long"].sort((a, b) => b.length - a.length), "[R]");
  assert.deepEqual(r.attributes({ k: "x abc-123456-long y abc-123456 z" }), { k: "x [R] y [R] z" });
});
