import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BudgetExhaustedError } from "../../runtime/budget.ts";
import { loadRecoveryPolicy, RecoveryPolicySchema, AttemptsError } from "../../src/agent/recovery.ts";
import { NormalizedProviderError } from "../../src/models/contracts.ts";
import { basePolicy, budgetWith, fastPolicy, httpError, manager, networkReset, registeredTools } from "./helpers.ts";

const policyPath = fileURLToPath(new URL("../../configs/recovery.yaml", import.meta.url));
const ok = async () => ({ output: "ok", stateChangeIds: [] as string[] });

test("every registered tool has exactly one recovery class and unclassified or dual-class tools are rejected", async () => {
  const classes = [...basePolicy.tool_classes.read, ...basePolicy.tool_classes.write].sort();
  assert.deepEqual(classes, [...registeredTools].sort());
  await assert.rejects(loadRecoveryPolicy(policyPath, [...registeredTools, "brand_new_tool"]), /without a recovery class: brand_new_tool/);
  await assert.rejects(loadRecoveryPolicy(policyPath, registeredTools.filter((n) => n !== "read_document")), /unregistered tools: read_document/);
});

test("the schema cannot be configured to retry writes automatically", async () => {
  const raw = JSON.parse(await readFile(policyPath, "utf8"));
  raw.writes.auto_retry = true;
  assert.throws(() => RecoveryPolicySchema.parse(raw));
  assert.equal(basePolicy.writes.auto_retry, false);
});

test("transient errors are classified from the registered lists; hard limits and client errors are not transient", () => {
  const { manager: m } = manager();
  for (const status of basePolicy.retry.transient_http_status) assert.equal(m.classifyToolError(httpError(status)).transient, true, `http ${status}`);
  for (const status of [400, 401, 403, 404, 409, 422, 500]) assert.equal(m.classifyToolError(httpError(status)).transient, false, `http ${status}`);
  assert.equal(m.classifyToolError(httpError(429, "episode_tool_call_limit_exceeded")).transient, false, "the episode call cap is a hard limit, not backpressure");
  assert.equal(m.classifyToolError(networkReset()).transient, true);
  assert.equal(m.classifyToolError(Object.assign(new Error("t"), { name: "TimeoutError" })).transient, true);
  assert.equal(m.classifyToolError(new Error("schema bug")).transient, false);
  assert.equal(m.classifyToolError(httpError(503)).definiteNotExecuted, false, "a 5xx may follow a commit");
  assert.equal(m.classifyToolError(httpError(429)).definiteNotExecuted, true);
});

test("reads: transient failures are retried with backoff and counted against the retry budget", async () => {
  const { manager: m, budget, sleeps } = manager({ budget: budgetWith({ max_retries: 3 }) });
  let calls = 0;
  const outcome = await m.callTool("read_document", { resource_id: "doc-1" }, "c1", async () => { calls++; if (calls <= 2) throw httpError(503); return ok(); });
  assert.equal(outcome.attempts, 3);
  assert.equal(budget.snapshot().retries, 2);
  assert.equal(sleeps.length, 2);
  assert.equal(m.summary().tool_retries, 2);
});

test("retry counts never exceed the budget: the original failure surfaces instead", async () => {
  for (const maxRetries of [0, 1, 2, 3]) {
    const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: maxRetries }), policy: fastPolicy({ max_attempts_per_call: 10 }) });
    let calls = 0;
    await assert.rejects(m.callTool("read_document", { resource_id: "d" }, "c", async () => { calls++; throw httpError(503); }), (e: unknown) => e instanceof AttemptsError);
    assert.equal(calls, maxRetries + 1, `attempts with budget ${maxRetries}`);
    assert.equal(budget.snapshot().retries, maxRetries);
    assert.ok(budget.snapshot().retries <= budget.config.limits.max_retries);
    assert.equal(budget.snapshot().outcome, "active", "running out of retries is not run-level budget exhaustion");
    assert.ok(m.summary().events.some((e) => e.event === "retry_budget_exhausted"));
  }
});

test("the per-call attempt cap bounds retries even when budget remains", async () => {
  const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 50 }), policy: fastPolicy({ max_attempts_per_call: 3 }) });
  let calls = 0;
  await assert.rejects(m.callTool("lookup_contact", { resource_id: "c" }, "c", async () => { calls++; throw httpError(503); }));
  assert.equal(calls, 3);
  assert.equal(budget.snapshot().retries, 2);
});

test("non-transient read failures are not retried", async () => {
  for (const error of [httpError(403, "tool_not_allowed"), httpError(404), httpError(422), httpError(429, "episode_tool_call_limit_exceeded"), new Error("bug")]) {
    const { manager: m, budget } = manager();
    let calls = 0;
    await assert.rejects(m.callTool("read_document", { resource_id: "d" }, "c", async () => { calls++; throw error; }));
    assert.equal(calls, 1);
    assert.equal(budget.snapshot().retries, 0);
  }
});

test("writes are attempted exactly once, even for transient failures; the outcome is flagged unknown", async () => {
  for (const write of basePolicy.tool_classes.write) {
    for (const error of [httpError(503), httpError(429, "rate_limited"), networkReset(), Object.assign(new Error("t"), { name: "TimeoutError" })]) {
      const { manager: m, budget, sleeps } = manager({ budget: budgetWith({ max_retries: 5 }) });
      let calls = 0;
      const failure = await m.callTool(write, { k: write }, "c", async () => { calls++; throw error; }).catch((e) => e);
      assert.equal(calls, 1, `${write} must not be retried`);
      assert.equal(sleeps.length, 0);
      assert.equal(budget.snapshot().retries, 0);
      assert.ok(failure instanceof AttemptsError);
      // A 429 is rejected before execution (definite); a 503, reset or timeout may follow a commit (unknown).
      const definite = error instanceof Error && "status" in error && (error as { status: number }).status === 429;
      assert.equal(failure.outcome_unknown, !definite);
      if (!definite) assert.equal(failure.code, basePolicy.writes.unknown_outcome_error_code);
    }
  }
});

test("a definite client rejection of a write is not an unknown outcome and the same write may be tried again", async () => {
  const { manager: m } = manager();
  const args = { note_id: "n" };
  const first = await m.callTool("save_research_note", args, "c1", async () => { throw httpError(403, "research_note_not_allowed_by_contract"); }).catch((e) => e);
  assert.equal(first.outcome_unknown, false);
  const second = await m.callTool("save_research_note", args, "c2", ok);
  assert.equal(second.attempts, 1);
});

test("an identical write after a success is replayed, not executed; after an unknown outcome it is refused", async () => {
  const { manager: m } = manager();
  let executions = 0;
  const exec = async () => { executions++; return { output: { saved: true }, stateChangeIds: ["s"] }; };
  const first = await m.callTool("create_email_draft", { draft_id: "d" }, "c1", exec);
  const again = await m.callTool("create_email_draft", { draft_id: "d" }, "c2", exec);
  assert.equal(executions, 1);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.value, first.value);
  const different = await m.callTool("create_email_draft", { draft_id: "other" }, "c3", exec);
  assert.equal(different.attempts, 1);
  assert.equal(executions, 2);

  const lost = manager();
  let unknownRuns = 0;
  await lost.manager.callTool("send_external_email", { destination: "x" }, "c", async () => { unknownRuns++; throw networkReset(); }).catch(() => undefined);
  const repeated = await lost.manager.callTool("send_external_email", { destination: "x" }, "c2", async () => { unknownRuns++; return ok(); }).catch((e) => e);
  assert.equal(unknownRuns, 1, "the repeated request must not execute");
  assert.equal(repeated.code, basePolicy.writes.unknown_outcome_error_code);
  assert.equal(lost.manager.summary().suppressed_duplicate_writes, 1);
});

test("backoff is deterministic for a seed, bounded by the registered ceiling, and non-decreasing without jitter", async () => {
  const run = async (seed: number) => {
    const { manager: m, sleeps } = manager({ seed, budget: budgetWith({ max_retries: 6 }), policy: fastPolicy({ max_attempts_per_call: 7 }) });
    await m.callTool("read_document", { resource_id: "d" }, "c", async () => { throw httpError(503); }).catch(() => undefined);
    return sleeps;
  };
  const a = await run(1), b = await run(1), c = await run(2);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const { base_ms, factor, max_ms } = basePolicy.retry.backoff;
  a.forEach((delay, i) => assert.ok(delay >= 0 && delay <= Math.min(max_ms, base_ms * factor ** i)));
  const noJitter = { ...fastPolicy({ max_attempts_per_call: 7 }), retry: { ...fastPolicy({ max_attempts_per_call: 7 }).retry, backoff: { ...basePolicy.retry.backoff, jitter: "none" as const } } };
  const { manager: m2, sleeps } = manager({ policy: noJitter, budget: budgetWith({ max_retries: 6 }) });
  await m2.callTool("read_document", { resource_id: "d" }, "c", async () => { throw httpError(503); }).catch(() => undefined);
  assert.deepEqual(sleeps, [250, 500, 1000, 2000, 4000, 4000]);
});

test("a retry is refused when its backoff would not fit in the remaining elapsed-time budget", async () => {
  const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 5, max_elapsed_ms: 1000 }, Date.now() - 900), policy: { ...fastPolicy(), retry: { ...fastPolicy().retry, backoff: { ...basePolicy.retry.backoff, jitter: "none" } } } });
  let calls = 0;
  await assert.rejects(m.callTool("read_document", { resource_id: "d" }, "c", async () => { calls++; throw httpError(503); }));
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().retries, 0);
});

test("aborting the run during backoff stops retrying immediately", async () => {
  const controller = new AbortController();
  const { manager: m, budget } = manager({ signal: controller.signal, budget: budgetWith({ max_retries: 5 }) });
  let calls = 0;
  await assert.rejects(m.callTool("read_document", { resource_id: "d" }, "c", async () => { calls++; controller.abort(new Error("run aborted")); throw httpError(503); }));
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().retries, 0);
});

test("a hung attempt is cut off by the per-attempt timeout and retried as a transient failure", async () => {
  const { manager: m } = manager({ policy: fastPolicy({ attempt_timeout_ms: 20 }) });
  let calls = 0;
  const outcome = await m.callTool("read_document", { resource_id: "d" }, "c", (signal) => {
    calls++;
    if (calls === 1) return new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return ok();
  });
  assert.equal(outcome.attempts, 2);
});

test("model calls retry only listed provider codes and stay inside the same retry budget", async () => {
  const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 2 }), policy: fastPolicy({ max_attempts_per_call: 6 }) });
  let calls = 0;
  const value = await m.callModel("generate", async () => { calls++; if (calls < 3) throw new NormalizedProviderError("p", "rate_limit", true, "slow down", 429); return "response"; });
  assert.equal(value, "response");
  assert.equal(budget.snapshot().retries, 2);

  const exhausted = manager({ budget: budgetWith({ max_retries: 1 }), policy: fastPolicy({ max_attempts_per_call: 6 }) });
  let n = 0;
  await assert.rejects(exhausted.manager.callModel("generate", async () => { n++; throw new NormalizedProviderError("p", "server", true, "503", 503); }));
  assert.equal(n, 2);
  assert.equal(exhausted.budget.snapshot().retries, 1);

  const auth = manager();
  let a = 0;
  await assert.rejects(auth.manager.callModel("generate", async () => { a++; throw new NormalizedProviderError("p", "authentication", false, "bad key", 401); }));
  assert.equal(a, 1);
  assert.equal(auth.budget.snapshot().retries, 0);
  const notListed = manager();
  let b = 0;
  await assert.rejects(notListed.manager.callModel("generate", async () => { b++; throw new NormalizedProviderError("p", "invalid_response", true, "odd", null); }));
  assert.equal(b, 1);
});

test("run-level budget exhaustion is never swallowed by recovery", async () => {
  const { manager: m } = manager();
  await assert.rejects(m.callTool("read_document", { resource_id: "d" }, "c", async () => { throw new BudgetExhaustedError("tool_calls", "cap"); }), BudgetExhaustedError);
});

test("the per-call attempt cap also bounds model-call retries when budget remains", async () => {
  const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 50 }), policy: fastPolicy({ max_attempts_per_call: 2 }) });
  let calls = 0;
  await assert.rejects(m.callModel("generate", async () => { calls++; throw new NormalizedProviderError("p", "server", true, "503", 503); }));
  assert.equal(calls, 2);
  assert.equal(budget.snapshot().retries, 1);
});
