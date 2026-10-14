import test from "node:test";
import assert from "node:assert/strict";
import {
  MockModelAdapter, NormalizedProviderError, OpenAIResponsesAdapter, type ModelRequest, type OpenAIResponsesTransport,
} from "../src/models/index.ts";

const request = (): ModelRequest => ({
  request_id: "request-001",
  messages: [
    { role: "system", content: "Use only allowed synthetic tools." },
    { role: "user", content: "Find the synthetic policy tier." },
  ],
  tools: [{
    name: "save_research_note",
    description: "Save one local research note.",
    parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  }],
  settings: { max_output_tokens: 256, temperature: null, top_p: null, seed: 7, reasoning_effort: "medium" },
});

const rawOpenAIResponse = () => ({
  id: "resp-001",
  model: "gpt-5.6-sol-test-revision",
  status: "completed",
  output: [
    { type: "message", id: "msg-001", content: [{ type: "output_text", text: "I found the cited value." }] },
    { type: "function_call", call_id: "call-001", name: "save_research_note", arguments: "{\"answer\":\"Silver\"}" },
  ],
  usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
});

class RecordingTransport implements OpenAIResponsesTransport {
  bodies: Record<string, unknown>[] = [];
  private readonly outcome: unknown;
  private readonly reject: boolean;
  constructor(outcome: unknown, reject = false) {
    this.outcome = outcome;
    this.reject = reject;
  }
  async create(body: Record<string, unknown>): Promise<unknown> {
    this.bodies.push(structuredClone(body));
    if (this.reject) throw this.outcome;
    return this.outcome;
  }
}

test("mock provider preserves the exact model, settings, usage and tool calls", async () => {
  const adapter = new MockModelAdapter("mock-script-v1", [{
    response_id: "mock-response-001",
    response_model: "mock-script-v1-revision-3",
    output_text: "",
    tool_calls: [{ call_id: "mock-call-001", tool_name: "save_research_note", arguments: { answer: "Silver" } }],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    finish_reason: "tool_call",
  }]);
  const result = await adapter.generate(request());
  assert.equal(result.requested_model, "mock-script-v1");
  assert.equal(result.response_model, "mock-script-v1-revision-3");
  assert.deepEqual(result.generation_settings, request().settings);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  assert.equal(result.tool_calls[0].tool_name, "save_research_note");
  assert.deepEqual(adapter.requests[0], request());
});

test("OpenAI Responses adapter normalizes messages, calls, usage and exact identifiers", async () => {
  const transport = new RecordingTransport(rawOpenAIResponse());
  const result = await new OpenAIResponsesAdapter("gpt-5.6-sol", transport).generate(request());
  assert.equal(result.provider, "openai");
  assert.equal(result.requested_model, "gpt-5.6-sol");
  assert.equal(result.response_model, "gpt-5.6-sol-test-revision");
  assert.equal(result.finish_reason, "tool_call");
  assert.equal(result.output_text, "I found the cited value.");
  assert.deepEqual(result.tool_calls[0], { call_id: "call-001", tool_name: "save_research_note", arguments: { answer: "Silver" } });
  assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 30, total_tokens: 150 });
  assert.deepEqual(transport.bodies[0].reasoning, { effort: "medium" });
  assert.equal(transport.bodies[0].model, "gpt-5.6-sol");
  assert.equal(transport.bodies[0].seed, 7);
});

test("malformed provider responses are rejected", async () => {
  const raw = rawOpenAIResponse() as Record<string, unknown>;
  delete raw.model;
  await assert.rejects(
    () => new OpenAIResponsesAdapter("gpt-5.6-sol", new RecordingTransport(raw)).generate(request()),
    (error: unknown) => error instanceof NormalizedProviderError && error.code === "invalid_response",
  );
});

test("invalid tool argument JSON is rejected", async () => {
  const raw = rawOpenAIResponse();
  raw.output[1].arguments = "{not-json";
  await assert.rejects(
    () => new OpenAIResponsesAdapter("gpt-5.6-sol", new RecordingTransport(raw)).generate(request()),
    (error: unknown) => error instanceof NormalizedProviderError && error.code === "invalid_response",
  );
});

test("invalid provider usage totals are rejected", async () => {
  const raw = rawOpenAIResponse();
  raw.usage.total_tokens = 149;
  await assert.rejects(
    () => new OpenAIResponsesAdapter("gpt-5.6-sol", new RecordingTransport(raw)).generate(request()),
    (error: unknown) => error instanceof NormalizedProviderError && error.code === "invalid_response",
  );
});

test("provider rate limits normalize to a retryable error", async () => {
  const native = Object.assign(new Error("Too many requests"), { status: 429, code: "rate_limit_exceeded" });
  await assert.rejects(
    () => new OpenAIResponsesAdapter("gpt-5.6-sol", new RecordingTransport(native, true)).generate(request()),
    (error: unknown) => error instanceof NormalizedProviderError && error.code === "rate_limit" && error.retryable && error.status === 429,
  );
});

test("authentication failures normalize to a non-retryable error", async () => {
  const native = Object.assign(new Error("Invalid credentials"), { status: 401 });
  await assert.rejects(
    () => new OpenAIResponsesAdapter("gpt-5.6-sol", new RecordingTransport(native, true)).generate(request()),
    (error: unknown) => error instanceof NormalizedProviderError && error.code === "authentication" && !error.retryable,
  );
});

test("invalid provider-neutral requests fail before transport", async () => {
  const transport = new RecordingTransport(rawOpenAIResponse());
  const invalid = { ...request(), messages: [] };
  await assert.rejects(() => new OpenAIResponsesAdapter("gpt-5.6-sol", transport).generate(invalid as ModelRequest));
  assert.equal(transport.bodies.length, 0);
});
