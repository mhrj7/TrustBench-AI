import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseTraceJsonl, reconstructExecutedToolCalls, serializeTraceJsonl, validateTrace, type TraceEvent } from "../schemas/trace.ts";

const fixture = await readFile(new URL("../fixtures/traces/valid-run.jsonl", import.meta.url), "utf8");
const cloneEvents = (): TraceEvent[] => structuredClone(parseTraceJsonl(fixture));

test("valid JSONL round-trips without information loss", () => {
  const parsed = parseTraceJsonl(fixture);
  assert.deepEqual(parseTraceJsonl(serializeTraceJsonl(parsed)), parsed);
});

test("reconstructs every executed tool call in execution order", () => {
  const calls = reconstructExecutedToolCalls(parseTraceJsonl(fixture));
  assert.deepEqual(calls.map(({ call_id, tool_name, status }) => ({ call_id, tool_name, status })), [
    { call_id: "call-search-1", tool_name: "search_documents", status: "succeeded" },
    { call_id: "call-read-1", tool_name: "read_document", status: "succeeded" },
  ]);
  assert.deepEqual(calls[1].arguments, { document_id: "doc-smoke-001", tenant_id: "tenant-smoke" });
});

test("rejects an invalid event shape", () => {
  const events = cloneEvents() as unknown[];
  (events[0] as Record<string, unknown>).unexpected = true;
  assert.throws(() => validateTrace(events), /Invalid trace event/);
});

test("rejects non-contiguous sequence numbers", () => {
  const events = cloneEvents();
  events[4].sequence = 99;
  assert.throws(() => validateTrace(events), /Non-contiguous sequence/);
});

test("rejects execution after a deny decision", () => {
  const events = cloneEvents();
  const decision = events.find((event) => event.event_type === "policy_decision");
  assert.ok(decision && decision.event_type === "policy_decision");
  decision.decision = "deny";
  assert.throws(() => validateTrace(events), /Executed call was not allowed/);
});

test("rejects a finished call without its start", () => {
  const events = cloneEvents().filter((event) => event.sequence !== 4);
  events.forEach((event, index) => { event.sequence = index; });
  assert.throws(() => validateTrace(events), /Tool finish lacks start/);
});

test("rejects tampered arguments even when the envelope remains valid", () => {
  const events = cloneEvents();
  const proposal = events.find((event) => event.event_type === "tool_call_proposed");
  assert.ok(proposal && proposal.event_type === "tool_call_proposed");
  proposal.arguments = { query: "tampered", tenant_id: "tenant-smoke" };
  assert.throws(() => validateTrace(events), /Argument hash mismatch/);
});

test("rejects secret-bearing field names", () => {
  const raw = fixture.replace('"tenant_id":"tenant-smoke"}', '"tenant_id":"tenant-smoke","api_key":"[REDACTED]"}');
  assert.throws(() => parseTraceJsonl(raw), /Forbidden secret-bearing field/);
});

test("rejects credential-shaped string values", () => {
  const raw = fixture.replace("Project Cedar policy tier", "sk-abcdefghijklmnop1234567890");
  assert.throws(() => parseTraceJsonl(raw), /Potential secret material/);
});

test("rejects a run summary that undercounts executed calls", () => {
  const events = cloneEvents();
  const finished = events.at(-1);
  assert.ok(finished && finished.event_type === "run_finished");
  finished.tool_calls_executed = 1;
  assert.throws(() => validateTrace(events), /does not match reconstructed calls/);
});
