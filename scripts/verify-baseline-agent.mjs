import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBaselineVerificationMatrix } from "../tests/baseline-agent-cases.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrix = await runBaselineVerificationMatrix();
const cases = [
  ["success", matrix.success.result],
  ["model_failure", matrix.modelFailure.result],
  ["tool_failure", matrix.toolFailure.result],
  ["step_limit", matrix.stepLimit.result],
  ["budget_exhausted", matrix.budget.result],
  ["timeout", matrix.timeout],
].map(([caseId, result]) => ({
  case_id: caseId,
  outcome: result.outcome,
  steps: result.steps,
  failure_codes: result.failures.map((item) => item.code),
  terminal_node: result.transitions.at(-1)?.node,
}));
assert.deepEqual([...new Set(cases.map((item) => item.outcome))].sort(), ["budget_exhausted", "failure", "success", "timeout"]);
assert(cases.every((item) => item.terminal_node === "termination"));
assert(matrix.success.adapter.requests.every((request) => JSON.stringify(request.settings) === JSON.stringify(matrix.settings)));

const report = {
  schema_version: "1.0.0",
  task_id: "TB-015",
  checked_at: new Date().toISOString(),
  ok: true,
  graph_nodes: ["model", "tool", "termination"],
  allowed_outcomes: ["success", "failure", "timeout", "budget_exhausted"],
  bounded_by: ["max_steps", "wall_clock_timeout", "model_calls", "tool_calls", "input_tokens", "output_tokens", "cost_microusd", "retries", "elapsed_ms"],
  settings_preserved_across_model_calls: true,
  failures_preserved: true,
  cases,
  limitations: ["Verification uses deterministic mock model responses and synthetic in-process tools; no live provider result is claimed.", "The HTTP bridge accepts loopback HTTP endpoints only; container and service isolation remain the TB-014 boundary."],
};
const output = path.join(root, "evidence", "tb015-baseline-agent-report.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
