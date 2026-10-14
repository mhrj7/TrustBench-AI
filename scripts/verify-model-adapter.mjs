import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { MockModelAdapter, OpenAIResponsesAdapter } from "../src/models/index.ts";

const settings = { max_output_tokens: 128, temperature: null, top_p: null, seed: 11, reasoning_effort: "medium" };
const request = {
  request_id: "tb013-verification",
  messages: [{ role: "user", content: "Return the synthetic fixture result." }],
  tools: [{ name: "fixture_result", description: "Record a synthetic result.", parameters: { type: "object", properties: {} } }],
  settings,
};
const mock = new MockModelAdapter("mock-script-v1", [{
  response_id: "mock-verification-response",
  response_model: "mock-script-v1-revision-1",
  output_text: "fixture complete",
  tool_calls: [],
  usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
  finish_reason: "stop",
}]);
const mockResult = await mock.generate(request);

let capturedBody;
const openai = new OpenAIResponsesAdapter("gpt-5.6-sol", { create: async (body) => {
  capturedBody = body;
  return { id: "resp-verification", model: "gpt-5.6-sol-test-revision", status: "completed", output: [], usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } };
} });
const openaiResult = await openai.generate(request);
assert.equal(mockResult.response_model, "mock-script-v1-revision-1");
assert.equal(openaiResult.requested_model, "gpt-5.6-sol");
assert.equal(openaiResult.response_model, "gpt-5.6-sol-test-revision");
assert.deepEqual(openaiResult.generation_settings, settings);
assert.equal(capturedBody.model, "gpt-5.6-sol");
assert.deepEqual(capturedBody.reasoning, { effort: "medium" });

const report = {
  schema_version: "1.0.0",
  task_id: "TB-013",
  checked_at: "2026-10-14",
  ok: true,
  implementations: ["mock", "openai_responses"],
  selected_provider: "openai",
  requested_model_id: openaiResult.requested_model,
  simulated_response_model_id: openaiResult.response_model,
  generation_settings: openaiResult.generation_settings,
  normalized_fields: ["messages", "tool_calls", "usage", "finish_reason", "provider_errors"],
  credentials_used: false,
  live_provider_request_made: false,
  limitations: [
    "The OpenAI transport is injected and deterministic in TB-013 tests; live provider integration is not claimed here.",
    "A seed is captured and forwarded when configured, but provider seed support does not guarantee deterministic outputs.",
  ],
};
await mkdir(new URL("../artifacts/verification/", import.meta.url), { recursive: true });
await writeFile(new URL("../artifacts/verification/tb013-model-adapter.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
