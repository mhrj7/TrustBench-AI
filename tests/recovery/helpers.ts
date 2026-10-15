import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadBudgetConfig, BudgetController, type BudgetConfig } from "../../runtime/budget.ts";
import { loadRecoveryPolicy, RecoveryManager, type RecoveryPolicy } from "../../src/agent/recovery.ts";
import { ToolServiceError } from "../../src/agent/http-tools.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const schedules = JSON.parse(await readFile(new URL("fault-schedules.json", import.meta.url), "utf8"));
export const registry = JSON.parse(await readFile(`${root}protocol/experiment-registry.yaml`, "utf8"));
export const manifests = JSON.parse(await readFile(`${root}src/policy/capability-manifests.json`, "utf8"));
export const registeredTools: string[] = Object.keys(manifests.argument_schemas);
export const basePolicy: RecoveryPolicy = await loadRecoveryPolicy(`${root}configs/recovery.yaml`, registeredTools);
const baseBudget: BudgetConfig = await loadBudgetConfig(`${root}configs/budget-local.yaml`);

/** Tests shrink time-based knobs only; classes, status lists and the write rules come from the registered file. */
export const fastPolicy = (overrides: { attempt_timeout_ms?: number; max_attempts_per_call?: number } = {}): RecoveryPolicy => ({
  ...basePolicy,
  retry: { ...basePolicy.retry, attempt_timeout_ms: overrides.attempt_timeout_ms ?? 50, max_attempts_per_call: overrides.max_attempts_per_call ?? basePolicy.retry.max_attempts_per_call },
});
export const budgetWith = (limits: Partial<BudgetConfig["limits"]>, startedAtMs = Date.now()) =>
  new BudgetController({ ...baseBudget, limits: { ...baseBudget.limits, ...limits } }, startedAtMs);

export function manager(options: { policy?: RecoveryPolicy; budget?: BudgetController; seed?: number; signal?: AbortSignal; sleeps?: number[] } = {}) {
  const budget = options.budget ?? budgetWith({ max_retries: 3 });
  const sleeps = options.sleeps ?? [];
  const controller = new AbortController();
  return {
    budget, sleeps, controller,
    manager: new RecoveryManager({
      policy: options.policy ?? fastPolicy(), budget, signal: options.signal ?? controller.signal,
      runId: "run-recovery-test", seed: options.seed ?? registry.pair_order_seed,
      sleep: async (ms) => { sleeps.push(ms); },
    }),
  };
}

export const httpError = (status: number, detail = "service_error") => new ToolServiceError(status, detail);
export const networkReset = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
