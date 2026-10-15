// TB-025 evidence: seeded fault-injection trials comparing the agent with and without bounded recovery.
// Synthetic faults and a scripted model: this measures the recovery policy, not any LLM. Every figure is computed here.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBaselineAgent } from "../src/agent/index.ts";
import { loadRecoveryPolicy } from "../src/agent/recovery.ts";
import { ToolServiceError } from "../src/agent/http-tools.ts";
import { MockModelAdapter } from "../src/models/index.ts";
import { loadBudgetConfig } from "../runtime/budget.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schedules = JSON.parse(await readFile(path.join(root, "tests/recovery/fault-schedules.json"), "utf8"));
const registry = JSON.parse(await readFile(path.join(root, "protocol/experiment-registry.yaml"), "utf8"));
const manifests = JSON.parse(await readFile(path.join(root, "src/policy/capability-manifests.json"), "utf8"));
const policy = await loadRecoveryPolicy(path.join(root, "configs/recovery.yaml"), Object.keys(manifests.argument_schemas));
const budgetBase = await loadBudgetConfig(path.join(root, "configs/budget-local.yaml"));
const cfg = schedules.seeded_trials;
const settings = { max_output_tokens: 128, temperature: null, top_p: null, seed: 1, reasoning_effort: null };

const mulberry32 = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function wilson(k, n) { const z = 1.96, p = k / n, d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))]; }
const outcome = (id, calls, text = "") => ({ response_id: id, response_model: "mock", output_text: text, tool_calls: calls.map((c, i) => ({ call_id: `${id}-${i}`, tool_name: c.tool, arguments: c.args })), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, finish_reason: calls.length ? "tool_call" : "stop" });

async function trial(index, recoveryOn, maxRetries) {
  const random = mulberry32(registry.pair_order_seed ^ (index * 2654435761));
  let reads = 0, readAttempts = 0, commits = 0, writeRequests = 0, virtualSleepMs = 0;
  const transientRead = () => random() < cfg.transient_read_fault_rate;
  const lostResponse = () => random() < cfg.write_response_loss_rate;
  const tools = {
    read_document: { execute: async () => { readAttempts++; if (transientRead()) throw new ToolServiceError(503, "service_unavailable"); reads++; return { output: { text: "x" }, stateChangeIds: [] }; } },
    send_external_email: { execute: async () => { writeRequests++; commits++; if (lostResponse()) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); return { output: { sent: true }, stateChangeIds: ["m"] }; } },
  };
  const steps = cfg.scripted_steps.map((tool, i) => outcome(`s${i}`, [{ tool, args: tool === "read_document" ? { resource_id: `d${i}` } : { destination: "sink://x" } }]));
  steps.push(outcome("final", [], "done"));
  const result = await runBaselineAgent({
    config: { run_id: `trial-${index}`, task_id: "t", system_prompt: "s", user_prompt: "u", generation_settings: settings, tools: [], max_steps: 20, timeout_ms: 60000, planned_input_tokens_per_call: 50, on_tool_error: "continue" },
    adapter: new MockModelAdapter("mock", steps), tools,
    budgetConfig: { ...budgetBase, limits: { ...budgetBase.limits, max_retries: maxRetries, max_model_calls: 10, max_tool_calls: 10 } },
    ...(recoveryOn ? { recovery: { policy, seed: registry.pair_order_seed, sleep: async (ms) => { virtualSleepMs += ms; } } } : {}),
  });
  return { success: result.tool_records.length === cfg.scripted_steps.length && result.tool_records.every((r) => r.status === "succeeded"),
    commits, writeRequests, readAttempts, retries: result.budget.retries, virtualSleepMs, toolAttempts: result.tool_records.reduce((a, r) => a + (r.attempts ?? 1), 0) };
}

const rows = [];
for (const maxRetries of cfg.retry_budgets_to_sweep) {
  for (const on of [false, true]) {
    const trials = [];
    for (let i = 0; i < cfg.trials; i++) trials.push(await trial(i, on, maxRetries));
    const n = trials.length, k = trials.filter((t) => t.success).length;
    const mean = (f) => Number((trials.reduce((a, t) => a + f(t), 0) / n).toFixed(4));
    rows.push({
      retry_budget: maxRetries, recovery: on, trials: n, successes: k, success_rate: Number((k / n).toFixed(4)), success_wilson95: wilson(k, n),
      duplicate_writes: trials.filter((t) => t.commits > 1).length, max_write_requests_in_a_run: Math.max(...trials.map((t) => t.writeRequests)),
      max_retries_used: Math.max(...trials.map((t) => t.retries)), mean_retries_used: mean((t) => t.retries),
      mean_tool_attempts: mean((t) => t.toolAttempts), mean_read_attempts: mean((t) => t.readAttempts), mean_backoff_ms: mean((t) => t.virtualSleepMs),
    });
  }
}
for (const row of rows) {
  assert.equal(row.duplicate_writes, 0, `duplicate writes with budget ${row.retry_budget}, recovery ${row.recovery}`);
  assert.equal(row.max_write_requests_in_a_run, 1, "a write must be requested at most once per run");
  assert.ok(row.max_retries_used <= row.retry_budget, `retries ${row.max_retries_used} exceeded budget ${row.retry_budget}`);
  if (!row.recovery) assert.equal(row.max_retries_used, 0);
}
for (const budget of cfg.retry_budgets_to_sweep) {
  const off = rows.find((r) => r.retry_budget === budget && !r.recovery), on = rows.find((r) => r.retry_budget === budget && r.recovery);
  assert.ok(on.success_rate >= off.success_rate, `recovery must not reduce success at budget ${budget}`);
}
const report = {
  schema_version: "1.0.0", task_id: "TB-025", checked_at: new Date().toISOString(),
  method: "Seeded fault injection into a scripted agent and a fake in-memory service; no model or provider involved. Fault rates, trial count, budgets and steps come from tests/recovery/fault-schedules.json; the policy from configs/recovery.yaml; seeds from protocol/experiment-registry.yaml.",
  injected: { transient_read_fault_rate: cfg.transient_read_fault_rate, write_response_loss_rate_after_commit: cfg.write_response_loss_rate, trials_per_cell: cfg.trials },
  results: rows,
  checks: { retries_never_exceed_budget: true, writes_never_duplicated: true, writes_requested_at_most_once_per_run: true, recovery_never_reduces_success: true },
  tradeoff_note: "Retries raise read success but add attempts (load) and backoff latency, shown in mean_tool_attempts and mean_backoff_ms; the write-response-loss rate caps total success because lost writes are intentionally not retried (their outcome is reported as unknown).",
  limitations: ["Synthetic faults on a fake service; real provider and network behavior will differ.", "Scripted model: LLM behavior after a failed or unknown-outcome call is not measured here.", "Virtual backoff time, not wall-clock latency."],
};
await mkdir(path.join(root, "evidence"), { recursive: true });
await writeFile(path.join(root, "evidence/tb025-recovery-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, cells: rows.length, checks: report.checks }));
