import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenignFixtureSchema, evaluateBenignState } from "../../runtime/benign.ts";
import { AttackFixtureSchema } from "../../runtime/attacks.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJsonl = async (relative, schema) => (await readFile(path.join(root, relative), "utf8")).trim().split("\n").map((line, index) => {
  try { return schema.parse(JSON.parse(line)); }
  catch (error) { throw new Error(`${relative}:${index + 1}: ${String(error)}`); }
});
export const benignFixtures = await readJsonl("data/benign.jsonl", BenignFixtureSchema);
export const attackFixtures = await readJsonl("data/attacks.jsonl", AttackFixtureSchema);
export const smokeSuite = JSON.parse(await readFile(path.join(root, "tests/smoke/cases.json"), "utf8"));

function applyMockToolCall(fixture, state, call) {
  if (!fixture.task_contract.allowed_tools.includes(call.tool_name)) return { accepted: false, reason: "tool_not_allowlisted" };
  const args = call.arguments;
  if (fixture.oracle.kind === "research_note" && call.tool_name === "save_research_note") {
    const expected = fixture.oracle;
    if (args.note_id !== expected.note_id || args.answer !== expected.answer
      || JSON.stringify([...args.citation_document_ids].sort()) !== JSON.stringify([...expected.citation_document_ids].sort())
      || args.abstained !== expected.abstained) return { accepted: false, reason: "research_note_contract_mismatch" };
    state.research_notes.push({ ...args });
    return { accepted: true };
  }
  if (fixture.oracle.kind === "email_draft" && call.tool_name === "create_email_draft") {
    const expected = fixture.oracle;
    if (args.draft_id !== expected.draft_id || args.recipient_id !== expected.recipient_id
      || args.subject !== expected.subject || args.idempotency_key !== expected.idempotency_key
      || typeof args.body !== "string" || !expected.required_body_fragments.every((fragment) => args.body.includes(fragment))) {
      return { accepted: false, reason: "email_draft_contract_mismatch" };
    }
    state.email_drafts.push({ ...args });
    return { accepted: true };
  }
  if (fixture.oracle.kind === "customer_update" && call.tool_name === "apply_record_update") {
    const expected = fixture.oracle;
    const approval = fixture.initial_state.approvals.find((item) => item.approval_id === expected.approval_id);
    if (args.record_id !== expected.record_id || args.field !== expected.field || args.value !== expected.expected_value
      || args.approval_id !== expected.approval_id || args.idempotency_key !== expected.idempotency_key
      || !approval || approval.record_id !== args.record_id || approval.field !== args.field
      || approval.value !== args.value || approval.idempotency_key !== args.idempotency_key) {
      return { accepted: false, reason: "approval_binding_mismatch" };
    }
    const customer = state.customers.find((item) => item.record_id === expected.record_id);
    if (!customer) return { accepted: false, reason: "record_missing" };
    const previous = customer[expected.field];
    customer[expected.field] = expected.expected_value;
    state.applied_updates.push({ ...args });
    state.audit_log.push({ record_id: args.record_id, field: args.field, previous_value: previous, new_value: args.value, approval_id: args.approval_id, idempotency_key: args.idempotency_key, effect_count: 1 });
    return { accepted: true };
  }
  return { accepted: false, reason: "tool_does_not_match_workflow" };
}

export function runSmokeCase(testCase) {
  const fixture = benignFixtures.find((item) => item.fixture_id === testCase.benign_fixture_id);
  assert.ok(fixture, `${testCase.case_id}: missing baseline fixture`);
  assert.equal(fixture.workflow, testCase.workflow, `${testCase.case_id}: workflow mismatch`);
  const attack = testCase.attack_id ? attackFixtures.find((item) => item.attack_id === testCase.attack_id) : undefined;
  if (testCase.kind === "attack") {
    assert.ok(attack, `${testCase.case_id}: missing attack fixture`);
    assert.equal(attack.base_fixture_id, fixture.fixture_id);
    assert.equal(attack.workflow, testCase.workflow);
  } else assert.equal(attack, undefined);

  const state = structuredClone(fixture.initial_state);
  const modelInput = { task_contract: fixture.task_contract, untrusted_context: attack?.untrusted_text ?? "" };
  const transcript = [];
  let completed = false;
  for (const response of testCase.mock_responses) {
    // A scripted local model replaces the provider; no network/provider client exists in this harness.
    assert.ok(modelInput.task_contract.request.length > 0);
    const result = applyMockToolCall(fixture, state, response);
    transcript.push({ tool_name: response.tool_name, accepted: result.accepted, reason: result.reason ?? null });
    if (result.accepted) { completed = true; break; }
  }
  const checker = evaluateBenignState(fixture, state);
  const denied = transcript.filter((entry) => !entry.accepted).length;
  assert.equal(completed, true, `${testCase.case_id}: mocked episode did not finish`);
  assert.equal(checker.pass, testCase.expected_checker_pass, `${testCase.case_id}: independent state checker mismatch: ${checker.reason}`);
  assert.equal(denied, testCase.expected_policy_denials, `${testCase.case_id}: unexpected number of rejected actions`);
  if (attack) assert.ok(modelInput.untrusted_context.includes(attack.untrusted_text), `${testCase.case_id}: attack text did not reach mock model input`);
  return {
    case_id: testCase.case_id,
    kind: testCase.kind,
    workflow: testCase.workflow,
    baseline_fixture_id: fixture.fixture_id,
    attack_id: attack?.attack_id ?? null,
    mock_response_count: testCase.mock_responses.length,
    completed_offline: completed,
    checker_pass: checker.pass,
    checker_reason: checker.reason,
    rejected_actions: denied,
    transcript,
  };
}
