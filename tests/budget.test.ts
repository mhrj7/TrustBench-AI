import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertPricingFresh, BudgetController, BudgetExhaustedError, estimateCostMicrousd, loadBudgetConfig, type BudgetConfig } from "../runtime/budget.ts";

const configPath = fileURLToPath(new URL("../configs/budget.yaml", import.meta.url));
const base = await loadBudgetConfig(configPath);
const withLimits = (limits: Partial<BudgetConfig["limits"]>) => ({ ...base, limits: { ...base.limits, ...limits } });

test("loads the versioned budget and current pricing snapshot", () => {
  assert.equal(base.pricing.pricing_model_id, "gpt-6-luna");
  assert.equal(base.pricing.service_tier, "fast");
  assert.doesNotThrow(() => assertPricingFresh(base, new Date("2026-10-14T15:00:00.000Z")));
  assert.throws(() => assertPricingFresh(base, new Date("2026-10-16T15:00:00.000Z")), /not valid at execution time/);
});

test("computes fast-tier cost in integer microdollars", () => {
  assert.equal(estimateCostMicrousd(base, 120, 30), 54);
  assert.equal(estimateCostMicrousd(base, 30000, 4000), 10000);
});

test("model-call exhaustion aborts pending work and records an explicit outcome", () => {
  const budget = new BudgetController(withLimits({ max_model_calls: 1 }), 0);
  let aborted = false;
  budget.signal.addEventListener("abort", () => { aborted = true; });
  budget.beginModelCall(1, 1, 0);
  assert.throws(() => budget.beginModelCall(1, 1, 0), BudgetExhaustedError);
  assert.equal(aborted, true);
  assert.deepEqual(budget.snapshot(), {
    outcome: "budget_exhausted", exhausted_dimension: "model_calls", reason: "Maximum model calls reached",
    model_calls: 1, tool_calls: 0, input_tokens: 0, output_tokens: 0, retries: 0,
    elapsed_ms: 0, cost_microusd: 0, pending_work_cancelled: true,
  });
});

test("planned currency overrun is blocked before the provider call", () => {
  const budget = new BudgetController(withLimits({ max_cost_microusd: 53 }), 0);
  assert.throws(() => budget.beginModelCall(120, 30, 0), /Planned call exceeds currency budget/);
  assert.equal(budget.snapshot().exhausted_dimension, "cost_microusd");
});

test("observed token overrun cancels remaining work", () => {
  const budget = new BudgetController(withLimits({ max_input_tokens: 5 }), 0);
  budget.beginModelCall(5, 1, 0);
  assert.throws(() => budget.recordModelUsage(6, 1), /Observed input exceeded token budget/);
  assert.equal(budget.signal.aborted, true);
});

test("tool-call limit is enforced", () => {
  const budget = new BudgetController(withLimits({ max_tool_calls: 1 }), 0);
  budget.recordToolCall();
  assert.throws(() => budget.recordToolCall(), /Maximum tool calls reached/);
});

test("retry limit is enforced", () => {
  const budget = new BudgetController(withLimits({ max_retries: 0 }), 0);
  assert.throws(() => budget.recordRetry(), /Maximum retries reached/);
});

test("elapsed-time limit is enforced", () => {
  const budget = new BudgetController(withLimits({ max_elapsed_ms: 10 }), 100);
  assert.throws(() => budget.checkElapsed(111), /Elapsed time/);
  assert.equal(budget.snapshot().elapsed_ms, 11);
});

test("an exhausted controller rejects further work", () => {
  const budget = new BudgetController(withLimits({ max_tool_calls: 0 }), 0);
  assert.throws(() => budget.recordToolCall(), BudgetExhaustedError);
  assert.throws(() => budget.recordRetry(), BudgetExhaustedError);
});
