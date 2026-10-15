import assert from "node:assert/strict";
import test from "node:test";
import { runBaselineAgent, type AgentToolRegistry } from "../../src/agent/index.ts";
import { MockModelAdapter, NormalizedProviderError, type GenerationSettings, type MockOutcome } from "../../src/models/index.ts";
import { loadBudgetConfig, type BudgetConfig } from "../../runtime/budget.ts";
import { basePolicy, fastPolicy, httpError, networkReset, registry } from "./helpers.ts";

const settings: GenerationSettings = { max_output_tokens: 128, temperature: null, top_p: null, seed: 1, reasoning_effort: null };
const budgetBase = await loadBudgetConfig(new URL("../../configs/budget-local.yaml", import.meta.url).pathname);
const withBudget = (limits: Partial<BudgetConfig["limits"]>): BudgetConfig => ({ ...budgetBase, limits: { ...budgetBase.limits, ...limits } });
const outcome = (id: string, calls: Array<{ tool: string; args: Record<string, unknown> }>, text = ""): Exclude<MockOutcome, Error> => ({
  response_id: id, response_model: "mock", output_text: text,
  tool_calls: calls.map((c, i) => ({ call_id: `${id}-${i}`, tool_name: c.tool, arguments: c.args })),
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, finish_reason: calls.length ? "tool_call" : "stop",
});

class Service {
  commits: Record<string, number> = {};
  reads = 0;
  readFaults: unknown[] = [];
  writeFaultAfterCommit: unknown[] = [];
  tools(): AgentToolRegistry {
    return {
      read_document: { execute: async () => { this.reads++; const f = this.readFaults.shift(); if (f) throw f; return { output: { text: "Silver" }, stateChangeIds: [] }; } },
      save_research_note: { execute: async (args) => { this.commits[JSON.stringify(args)] = (this.commits[JSON.stringify(args)] ?? 0) + 1; const f = this.writeFaultAfterCommit.shift(); if (f) throw f; return { output: { saved: true }, stateChangeIds: ["n1"] }; } },
    };
  }
  get totalCommits() { return Object.values(this.commits).reduce((a, b) => a + b, 0); }
}

const run = async (service: Service, outcomes: MockOutcome[], limits: Partial<BudgetConfig["limits"]>, recovery: boolean, onToolError: "stop" | "continue" = "continue") => {
  const adapter = new MockModelAdapter("mock", outcomes);
  const sleeps: number[] = [];
  const result = await runBaselineAgent({
    config: {
      run_id: "run-recovery-runner", task_id: "t", system_prompt: "s", user_prompt: "u", generation_settings: settings,
      tools: [], max_steps: 12, timeout_ms: 5000, planned_input_tokens_per_call: 50, on_tool_error: onToolError,
    },
    adapter, tools: service.tools(), budgetConfig: withBudget(limits),
    ...(recovery ? { recovery: { policy: fastPolicy(), seed: registry.pair_order_seed, sleep: async (ms: number) => { sleeps.push(ms); } } } : {}),
  });
  return { result, sleeps, adapter };
};
const note = { note_id: "n", answer: "Silver", citation_document_ids: ["d"], abstained: false };

test("a transient read failure is recovered inside the run, counted once in the retry budget and recorded per call", async () => {
  const service = new Service(); service.readFaults = [httpError(503)];
  const { result, sleeps } = await run(service, [outcome("a", [{ tool: "read_document", args: { resource_id: "d" } }]), outcome("b", [{ tool: "save_research_note", args: note }]), outcome("c", [], "done")], { max_retries: 2 }, true);
  assert.equal(result.outcome, "success");
  assert.equal(result.tool_records[0]!.attempts, 2);
  assert.equal(result.budget.retries, 1);
  assert.equal(result.recovery!.tool_retries, 1);
  assert.equal(sleeps.length, 1);
  assert.equal(service.commits[JSON.stringify(note)], 1);
  assert.equal(result.budget.tool_calls, 2, "a retried attempt is not a new logical tool call");
});

test("without a recovery policy the TB-015 behavior is unchanged: a transient read failure fails the call", async () => {
  const service = new Service(); service.readFaults = [httpError(503)];
  const { result } = await run(service, [outcome("a", [{ tool: "read_document", args: { resource_id: "d" } }])], { max_retries: 2 }, false, "stop");
  assert.equal(result.outcome, "failure");
  assert.equal(service.reads, 1);
  assert.equal(result.recovery, undefined);
  assert.equal(result.budget.retries, 0);
});

test("retries stop at the budget and the failure is reported, never hidden", async () => {
  const service = new Service(); service.readFaults = [httpError(503), httpError(503), httpError(503), httpError(503)];
  const { result } = await run(service, [outcome("a", [{ tool: "read_document", args: { resource_id: "d" } }])], { max_retries: 1 }, true, "stop");
  assert.equal(result.outcome, "failure");
  assert.equal(service.reads, 2, "one attempt plus the single budgeted retry");
  assert.equal(result.budget.retries, 1);
  assert.ok(result.budget.retries <= 1);
  assert.equal(result.tool_records[0]!.status, "failed");
  assert.equal(result.tool_records[0]!.attempts, 2);
  assert.ok(result.recovery!.events.some((e) => e.event === "retry_budget_exhausted"));
});

test("a write whose response is lost is not retried, flagged unknown, and an identical repeat by the model is suppressed", async () => {
  const service = new Service(); service.writeFaultAfterCommit = [networkReset()];
  const { result, adapter } = await run(service, [
    outcome("a", [{ tool: "save_research_note", args: note }]),
    outcome("b", [{ tool: "save_research_note", args: note }]),
    outcome("c", [], "stopping"),
  ], { max_retries: 5 }, true);
  assert.equal(service.totalCommits, 1, "the write executed exactly once");
  assert.equal(result.tool_records[0]!.outcome_unknown, true);
  assert.equal(result.tool_records[0]!.attempts, 1);
  assert.equal(result.tool_records[1]!.attempts, 0);
  assert.equal(result.tool_records[1]!.error_code, basePolicy.writes.unknown_outcome_error_code);
  assert.equal(result.recovery!.suppressed_duplicate_writes, 1);
  assert.equal(result.budget.retries, 0);
  assert.match(adapter.requests[1]!.messages.at(-1)!.content, /may or may not have been applied/);
});

test("model-call retries share the same budget and a model outage beyond it ends the run with an explicit failure", async () => {
  const service = new Service();
  const rate = () => new NormalizedProviderError("mock", "rate_limit", true, "slow down", 429);
  const ok = await run(service, [rate(), outcome("a", [], "fine")], { max_retries: 2 }, true);
  assert.equal(ok.result.outcome, "success");
  assert.equal(ok.result.budget.retries, 1);
  assert.equal(ok.result.budget.model_calls, 1, "a retried model request is one logical model call");
  const down = await run(new Service(), [rate(), rate(), rate()], { max_retries: 1 }, true);
  assert.equal(down.result.outcome, "failure");
  assert.equal(down.result.budget.retries, 1);
  assert.equal(down.result.failures[0]!.code, "rate_limit");
});

test("registered limits are the only source of truth: the run budget file bounds retries for every outcome", async () => {
  for (const maxRetries of [0, 1, 3]) {
    const service = new Service(); service.readFaults = Array.from({ length: 20 }, () => httpError(503));
    const { result } = await run(service, [outcome("a", [{ tool: "read_document", args: { resource_id: "d" } }]), outcome("b", [], "x")], { max_retries: maxRetries }, true);
    assert.ok(result.budget.retries <= maxRetries, `retries ${result.budget.retries} within ${maxRetries}`);
    assert.ok(service.reads <= maxRetries + 1);
  }
});
