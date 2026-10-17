import assert from "node:assert/strict";
import test from "node:test";
import { createHttpToolRegistry } from "../src/agent/index.ts";
import { runBaselineVerificationMatrix } from "./baseline-agent-cases.ts";

test("bounded graph terminates every deterministic trajectory and preserves failures", async () => {
  const matrix = await runBaselineVerificationMatrix();
  assert.equal(matrix.success.result.outcome, "success");
  assert.deepEqual(matrix.success.result.transitions.map((item) => item.node), ["model", "tool", "model", "termination"]);
  assert.equal(matrix.success.result.tool_records[0].status, "succeeded");
  assert.equal(matrix.success.result.failures.length, 0);
  assert.equal(matrix.modelFailure.result.outcome, "failure");
  assert.equal(matrix.modelFailure.result.failures[0].code, "server");
  assert.equal(matrix.toolFailure.result.outcome, "failure");
  assert.equal(matrix.toolFailure.result.failures[0].code, "synthetic_tool_failure");
  assert.equal(matrix.toolFailure.result.tool_records[0].status, "failed");
  assert.equal(matrix.stepLimit.result.outcome, "failure");
  assert.equal(matrix.stepLimit.result.failures[0].code, "step_limit_exceeded");
  assert.equal(matrix.stepLimit.result.steps, 2);
  assert.equal(matrix.stepLimit.result.transitions.at(-1)?.node, "termination");
  assert.equal(matrix.budget.result.outcome, "budget_exhausted");
  assert.equal(matrix.budget.result.budget.exhausted_dimension, "model_calls");
  assert.equal(matrix.budget.result.budget.pending_work_cancelled, true);
  assert.equal(matrix.timeout.outcome, "timeout");
  // TB-040: the mock model never answers, so the run timeout fires while a model call is in flight: a provider timeout on
  // the model node (the run is invalid), not an agent outcome.
  assert.equal(matrix.timeout.failures[0].code, "timeout");
  assert.equal(matrix.timeout.failures[0].node, "model");
  // A run timeout while a tool (not the provider) holds the run stays an agent timeout.
  assert.equal(matrix.toolTimeout.result.outcome, "timeout");
  assert.equal(matrix.toolTimeout.result.failures[0].code, "AgentTimeoutError");
  assert.equal(matrix.timeoutSignalAborted, true);
  // on_tool_error=continue returns the failure to the model, which can recover; the failure stays in the record.
  assert.equal(matrix.continued.result.outcome, "success");
  assert.deepEqual(matrix.continued.result.tool_records.map((r) => r.status), ["failed", "succeeded"]);
  assert.equal(matrix.continued.result.failures[0].code, "synthetic_tool_failure");
  assert.match(matrix.continued.adapter.requests[1].messages.at(-1)!.content, /synthetic_tool_failure/);
  for (const result of [matrix.success.result, matrix.modelFailure.result, matrix.toolFailure.result, matrix.stepLimit.result, matrix.budget.result, matrix.timeout]) {
    assert(["success", "failure", "timeout", "budget_exhausted"].includes(result.outcome));
    assert.equal(result.transitions.at(-1)?.node, "termination");
  }
  assert(matrix.stepLimit.result.steps <= 2, "work-node count must remain within configured max_steps");
});

test("generation settings remain identical across every model step", async () => {
  const { success, settings } = await runBaselineVerificationMatrix();
  assert.equal(success.adapter.requests.length, 2);
  for (const request of success.adapter.requests) assert.deepEqual(request.settings, settings);
  assert.deepEqual(success.result.generation_settings, settings);
});

test("HTTP tool bridge permits loopback only and forwards structured failures", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const registry = createHttpToolRegistry({
    baseUrl: "http://127.0.0.1:8000",
    episodeId: "episode-001",
    fetchImpl: async (url, init) => {
      seen.url = String(url); seen.init = init;
      return new Response(JSON.stringify({ detail: "tool_not_allowed_by_contract" }), { status: 403, headers: { "content-type": "application/json" } });
    },
  });
  const controller = new AbortController();
  await assert.rejects(
    () => registry.read_document.execute({ resource_id: "doc-001" }, { runId: "r", taskId: "t", callId: "c", signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "ToolServiceError" && (error as { code?: string }).code === "tool_not_allowed_by_contract",
  );
  assert.equal(seen.url, "http://127.0.0.1:8000/v1/episodes/episode-001/tools/read_document");
  assert.equal(seen.init?.signal, controller.signal);
  assert.throws(() => createHttpToolRegistry({ baseUrl: "https://public.example.com", episodeId: "episode-001" }), /loopback/);
});

