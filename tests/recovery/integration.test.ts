import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHttpToolRegistry } from "../../src/agent/http-tools.ts";
import { faultyFetch, type FaultRule } from "./faulty-fetch.ts";
import { basePolicy, budgetWith, fastPolicy, manager, schedules } from "./helpers.ts";
import { startToolService, type RunningService } from "./service.ts";

const EMAIL_ATTACK = "TB-BEN-EMAIL-001--TB-ATT-EMAIL-002";
let permissive: RunningService, contract: RunningService;
before(async () => { [permissive, contract] = await Promise.all([startToolService("permissive"), startToolService("contract")]); });
after(async () => { await Promise.all([permissive.stop(), contract.stop()]); });

const rules = (id: string): FaultRule[] => schedules.rules[id];
const signal = () => new AbortController().signal;
const context = (s: AbortSignal, attempt = 1) => ({ runId: "r", taskId: "t", callId: "c", signal: s, attempt });
const registryWith = (service: RunningService, episode: string, rule: string | null) => {
  const fetchImpl = faultyFetch(fetch, rule ? rules(rule) : []);
  return { tools: createHttpToolRegistry({ baseUrl: service.baseUrl, episodeId: episode, fetchImpl }), fetchImpl };
};
const sentEmails = async (service: RunningService, episode: string) => (await service.state(episode)).state.sent_emails.length;

test("reads: injected 503s and timeouts are recovered within the retry budget and leave state unchanged", async () => {
  for (const [rule, expectedRetries] of [["read_503_twice_then_ok", 2], ["read_timeout_then_ok", 1], ["read_connection_reset_then_ok", 1]] as const) {
    const episode = `read-${rule}`;
    await permissive.reset(episode, "TB-BEN-DOC-001");
    const before = (await permissive.state(episode)).state;
    const { tools, fetchImpl } = registryWith(permissive, episode, rule);
    const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 3 }), policy: fastPolicy({ attempt_timeout_ms: 80 }) });
    const outcome = await m.callTool("read_document", { resource_id: "doc-cedar-policy" }, "c", (s, attempt) => tools.read_document!.execute({ resource_id: "doc-cedar-policy" }, context(s, attempt)));
    assert.equal((outcome.value.output as { document_id: string }).document_id, "doc-cedar-policy");
    assert.equal(budget.snapshot().retries, expectedRetries, rule);
    assert.ok(budget.snapshot().retries <= budget.config.limits.max_retries);
    assert.equal(fetchImpl.injected.length, expectedRetries, `${rule} injected faults`);
    assert.deepEqual((await permissive.state(episode)).state, before, "a retried read must not change synthetic state");
  }
});

test("rate limits that never clear stop at the retry budget; the episode call cap is not retried", async () => {
  const episode = "read-rate-limit";
  await permissive.reset(episode, "TB-BEN-DOC-001");
  const { tools, fetchImpl } = registryWith(permissive, episode, "read_429_rate_limit_always");
  const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 2 }), policy: fastPolicy({ max_attempts_per_call: 8 }) });
  await assert.rejects(m.callTool("read_document", { resource_id: "doc-cedar-policy" }, "c", (s, a) => tools.read_document!.execute({ resource_id: "doc-cedar-policy" }, context(s, a))));
  assert.equal(budget.snapshot().retries, 2);
  assert.equal(fetchImpl.attempts.read_document, 3, "one attempt plus exactly the budgeted retries");

  const capped = "read-call-cap";
  await permissive.reset(capped, "TB-BEN-DOC-001", 1);
  const plain = registryWith(permissive, capped, null).tools;
  const mm = manager({ budget: budgetWith({ max_retries: 5 }) });
  await mm.manager.callTool("read_document", { resource_id: "doc-cedar-policy" }, "c1", (s, a) => plain.read_document!.execute({ resource_id: "doc-cedar-policy" }, context(s, a)));
  const second = await mm.manager.callTool("read_document", { resource_id: "doc-cedar-policy" }, "c2", (s, a) => plain.read_document!.execute({ resource_id: "doc-cedar-policy" }, context(s, a))).catch((e) => e);
  assert.equal(second.code, "episode_tool_call_limit_exceeded");
  assert.equal(second.attempts, 1);
  assert.equal(mm.budget.snapshot().retries, 0, "a hard cap is not backpressure");
});

test("writes: a response lost after the service committed is never retried, so the effect happens exactly once", async () => {
  for (const rule of ["write_response_lost_after_commit", "write_503_after_commit"] as const) {
    const episode = `write-${rule}`;
    await permissive.reset(episode, EMAIL_ATTACK);
    const { tools, fetchImpl } = registryWith(permissive, episode, rule);
    const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 5 }) });
    const args = { destination: "sink://fixture-state/sent-email/TB-ATT-EMAIL-002", body: "hello" };
    const run = () => m.callTool("send_external_email", args, "c", (s, a) => tools.send_external_email!.execute(args, context(s, a)));
    const failure = await run().catch((e) => e);
    assert.equal(failure.outcome_unknown, true, rule);
    assert.equal(failure.code, basePolicy.writes.unknown_outcome_error_code);
    assert.equal(await sentEmails(permissive, episode), 1, "the commit happened exactly once");
    // The model asks again for the identical write: recovery refuses to execute it.
    const again = await run().catch((e) => e);
    assert.equal(again.code, basePolicy.writes.unknown_outcome_error_code);
    assert.equal(fetchImpl.attempts.send_external_email, 1, "no second request reached the service");
    assert.equal(await sentEmails(permissive, episode), 1);
    assert.equal(budget.snapshot().retries, 0);
  }
});

test("writes rejected before reaching the service are also not retried automatically", async () => {
  const episode = "write-503-before";
  await permissive.reset(episode, EMAIL_ATTACK);
  const { tools, fetchImpl } = registryWith(permissive, episode, "write_503_before_reach");
  const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 5 }) });
  const args = { destination: "sink://x", body: "b" };
  const failure = await m.callTool("send_external_email", args, "c", (s, a) => tools.send_external_email!.execute(args, context(s, a))).catch((e) => e);
  assert.equal(fetchImpl.attempts.send_external_email, 1);
  assert.equal(budget.snapshot().retries, 0);
  assert.equal(failure.outcome_unknown, true, "a 5xx cannot prove the request never ran, so it is reported as unknown");
  assert.equal(await sentEmails(permissive, episode), 0);
});

test("negative control: a naive retry-everything loop DOES duplicate the write that recovery protects", async () => {
  const episode = "write-naive-control";
  await permissive.reset(episode, EMAIL_ATTACK);
  const { tools } = registryWith(permissive, episode, "write_response_lost_after_commit");
  const args = { destination: "sink://naive", body: "b" };
  let result: unknown;
  for (let attempt = 1; attempt <= 3 && result === undefined; attempt++) {
    try { result = await tools.send_external_email!.execute(args, context(signal(), attempt)); } catch { /* naive: retry on any failure */ }
  }
  assert.equal(await sentEmails(permissive, episode), 2, "without the write rule the lost response causes a duplicate send");
});

test("recovery keeps working against the contract-checked backend (same classes, same invariants)", async () => {
  const episode = "contract-read";
  await contract.reset(episode, "TB-BEN-DOC-001");
  const { tools } = registryWith(contract, episode, "read_503_twice_then_ok");
  const { manager: m, budget } = manager({ budget: budgetWith({ max_retries: 3 }) });
  const out = await m.callTool("read_document", { resource_id: "doc-cedar-policy" }, "c", (s, a) => tools.read_document!.execute({ resource_id: "doc-cedar-policy" }, context(s, a)));
  assert.equal(out.attempts, 3);
  assert.equal(budget.snapshot().retries, 2);
});
