import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertPricingFresh,
  BudgetController,
  BudgetExhaustedError,
  estimateCostMicrousd,
  loadBudgetConfig,
} from "../runtime/budget.ts";

const root = new URL("../", import.meta.url);
const config = await loadBudgetConfig(fileURLToPath(new URL("configs/budget.yaml", root)));
const evidence = JSON.parse(await readFile(new URL("artifacts/pilots/tb005-provider-pilot.json", root), "utf8"));
const request = evidence.representative_provider_request;
const pricing = evidence.pricing_at_execution;

assert.equal(evidence.task_id, "TB-005");
assert.equal(evidence.secrets_stored, false);
assert.equal(request.provider_path, "codex.responses");
assert.equal(request.response_model, config.pricing.pricing_model_id);
assert.equal(request.service_tier, config.pricing.service_tier);
assert.equal(request.outcome, "completed");
assert.equal(request.authorization_decision, "denied");
assert.equal(request.tool_calls, 0);
assert.match(request.rate_limit_observation, /without a rate-limit or quota error/);
assert.ok(Number.isInteger(request.input_tokens) && request.input_tokens > 0);
assert.ok(Number.isInteger(request.output_tokens) && request.output_tokens > 0);
assert.ok(request.provider_span_elapsed_ms > 0);
assert.ok(request.end_to_end_elapsed_ms >= request.provider_span_elapsed_ms);

assert.equal(pricing.input_usd_per_million_tokens, config.pricing.input_usd_per_million_tokens);
assert.equal(pricing.output_usd_per_million_tokens, config.pricing.output_usd_per_million_tokens);
assert.equal(pricing.pricing_model_id, config.pricing.pricing_model_id);
assert.equal(pricing.service_tier, config.pricing.service_tier);
assert.equal(pricing.verified_at, config.pricing.verified_at);
assert.equal(pricing.source_url, config.pricing.source_url);
assert.equal(pricing.api_equivalent_cost_microusd, estimateCostMicrousd(config, request.input_tokens, request.output_tokens));
assert.equal(pricing.api_equivalent_cost_usd, pricing.api_equivalent_cost_microusd / 1_000_000);
assert.ok(pricing.api_equivalent_cost_microusd <= config.limits.max_cost_microusd);
assertPricingFresh(config, new Date(request.started_at));
assert.deepEqual(evidence.configured_per_run_limits, config.limits);
assert.equal(evidence.runtime_warnings.length, 1);
assert.equal(evidence.runtime_warnings[0].impact_on_tb005, "none");

const forced = new BudgetController(config, 0);
let abortEventObserved = false;
forced.signal.addEventListener("abort", () => { abortEventObserved = true; });
for (let call = 0; call < config.limits.max_model_calls; call += 1) {
  forced.beginModelCall(1, 1, 0);
}
assert.throws(() => forced.beginModelCall(1, 1, 0), BudgetExhaustedError);
assert.equal(abortEventObserved, true);
assert.equal(forced.signal.aborted, true);
assert.throws(() => forced.recordRetry(), BudgetExhaustedError);
const forcedSnapshot = forced.snapshot();
assert.equal(forcedSnapshot.outcome, evidence.forced_exhaustion.outcome);
assert.equal(forcedSnapshot.exhausted_dimension, evidence.forced_exhaustion.exhausted_dimension);
assert.equal(forcedSnapshot.reason, evidence.forced_exhaustion.reason);
assert.equal(forcedSnapshot.model_calls, evidence.forced_exhaustion.model_calls_admitted);
assert.equal(forcedSnapshot.pending_work_cancelled, evidence.forced_exhaustion.pending_work_cancelled);
assert.equal(evidence.forced_exhaustion.abort_event_observed, abortEventObserved);
assert.equal(evidence.forced_exhaustion.subsequent_work_rejected, true);

console.log(JSON.stringify({
  task: "TB-005",
  provider_request: "verified",
  input_tokens: request.input_tokens,
  output_tokens: request.output_tokens,
  elapsed_ms: request.end_to_end_elapsed_ms,
  api_equivalent_cost_microusd: pricing.api_equivalent_cost_microusd,
  forced_outcome: forcedSnapshot.outcome,
  pending_work_cancelled: forcedSnapshot.pending_work_cancelled,
}, null, 2));
