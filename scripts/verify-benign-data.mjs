import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BenignFixtureSchema, evaluateBenignState } from "../runtime/benign.ts";

const root = new URL("../", import.meta.url);
const sourceLines = (await readFile(new URL("data/benign.jsonl", root), "utf8")).trim().split("\n");
const fixtures = sourceLines.map((line, index) => {
  try { return BenignFixtureSchema.parse(JSON.parse(line)); }
  catch (error) { throw new Error(`Invalid benign fixture at line ${index + 1}: ${String(error)}`); }
});
assert.ok(fixtures.length >= 3, "Expected coverage for all three in-scope workflows");
assert.equal(new Set(fixtures.map((fixture) => fixture.fixture_id)).size, fixtures.length, "Fixture IDs must be unique");
assert.deepEqual(new Set(fixtures.map((fixture) => fixture.workflow)), new Set([
  "document_evidence_analyst", "email_draft_assistant", "controlled_record_update",
]));

const db = new DatabaseSync(fileURLToPath(new URL("data/benign.sqlite", root)), { readOnly: true });
const dbFixtures = db.prepare("SELECT fixture_id, fixture_version, synthetic, tenant_id, workflow, task_contract_json, oracle_json FROM fixtures ORDER BY fixture_id").all();
assert.equal(dbFixtures.length, fixtures.length, "SQLite fixture rows must match JSONL source of truth");
for (const fixture of fixtures) {
  assert.ok(fixture.initial_state.users.some((user) => user.user_id === fixture.task_contract.user_id && user.tenant_id === fixture.tenant_id), `${fixture.fixture_id} must bind an explicit synthetic task user`);
  for (const entity of ["users", "documents", "contacts", "customers", "approvals"]) {
    assert.ok(fixture.initial_state[entity].every((row) => row.tenant_id === fixture.tenant_id), `${fixture.fixture_id} has cross-tenant ${entity}`);
  }
  assert.ok(fixture.initial_state.users.every((user) => user.email.endsWith(".example.invalid") || user.email.endsWith("@example.invalid")), `${fixture.fixture_id} contains a non-test user email`);
  assert.ok(fixture.initial_state.contacts.every((contact) => contact.email.endsWith("@example.invalid")), `${fixture.fixture_id} contains a non-test contact email`);
  if (fixture.workflow === "document_evidence_analyst") {
    assert.ok(fixture.task_contract.allowed_document_ids.every((documentId) => fixture.initial_state.documents.some((document) => document.document_id === documentId)), `${fixture.fixture_id} references a missing allowed document`);
    assert.ok(fixture.oracle.citation_document_ids.every((documentId) => fixture.task_contract.allowed_document_ids.includes(documentId)), `${fixture.fixture_id} oracle cites a document outside the task allowlist`);
  }
  if (fixture.workflow === "email_draft_assistant") {
    assert.ok(fixture.initial_state.contacts.some((contact) => contact.contact_id === fixture.task_contract.recipient_id), `${fixture.fixture_id} references a missing recipient`);
    assert.ok(fixture.oracle.recipient_id === fixture.task_contract.recipient_id && fixture.oracle.subject === fixture.task_contract.subject && fixture.oracle.idempotency_key === fixture.task_contract.idempotency_key, `${fixture.fixture_id} email oracle differs from trusted task contract`);
    assert.ok(fixture.oracle.required_body_fragments.every((fragment) => fixture.initial_state.documents.some((document) => document.tenant_id === fixture.tenant_id && document.content.includes(fragment))), `${fixture.fixture_id} email expectations lack synthetic source evidence`);
  }
  if (fixture.workflow === "controlled_record_update") {
    assert.ok(fixture.initial_state.customers.some((customer) => customer.record_id === fixture.task_contract.record_id), `${fixture.fixture_id} references a missing customer`);
    assert.ok(fixture.initial_state.approvals.some((approval) => approval.approval_id === fixture.task_contract.approval_id), `${fixture.fixture_id} references a missing approval`);
    assert.ok(fixture.oracle.record_id === fixture.task_contract.record_id && fixture.oracle.field === fixture.task_contract.field && fixture.oracle.expected_value === fixture.task_contract.value && fixture.oracle.approval_id === fixture.task_contract.approval_id && fixture.oracle.idempotency_key === fixture.task_contract.idempotency_key, `${fixture.fixture_id} update oracle differs from trusted task contract`);
    assert.ok(fixture.initial_state.customers.find((customer) => customer.record_id === fixture.task_contract.record_id)?.allowlisted_fields.includes(fixture.task_contract.field), `${fixture.fixture_id} field is not allowlisted in seeded state`);
    assert.ok(fixture.initial_state.approvals.some((approval) => approval.approval_id === fixture.task_contract.approval_id && approval.tenant_id === fixture.tenant_id && approval.record_id === fixture.task_contract.record_id && approval.field === fixture.task_contract.field && approval.value === fixture.task_contract.value && approval.idempotency_key === fixture.task_contract.idempotency_key && approval.single_use), `${fixture.fixture_id} approval does not bind the exact authorized update`);
  }
  const row = db.prepare("SELECT fixture_version, synthetic, tenant_id, workflow, task_contract_json, oracle_json FROM fixtures WHERE fixture_id = ?").get(fixture.fixture_id);
  assert.ok(row, `Missing SQLite fixture ${fixture.fixture_id}`);
  assert.equal(row.synthetic, 1);
  assert.equal(row.fixture_version, fixture.fixture_version);
  assert.equal(row.tenant_id, fixture.tenant_id);
  assert.equal(row.workflow, fixture.workflow);
  assert.deepEqual(JSON.parse(row.task_contract_json), fixture.task_contract);
  assert.deepEqual(JSON.parse(row.oracle_json), fixture.oracle);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE fixture_id = ?").get(fixture.fixture_id).n, fixture.initial_state.users.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE fixture_id = ?").get(fixture.fixture_id).n, fixture.initial_state.documents.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE fixture_id = ?").get(fixture.fixture_id).n, fixture.initial_state.contacts.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE fixture_id = ?").get(fixture.fixture_id).n, fixture.initial_state.customers.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE fixture_id = ?").get(fixture.fixture_id).n, fixture.initial_state.approvals.length);
}
db.close();

const withState = (fixture, patch) => ({
  ...fixture.initial_state,
  research_notes: [...fixture.initial_state.research_notes],
  email_drafts: [...fixture.initial_state.email_drafts],
  sent_emails: [...fixture.initial_state.sent_emails],
  applied_updates: [...fixture.initial_state.applied_updates],
  audit_log: [...fixture.initial_state.audit_log],
  customers: fixture.initial_state.customers.map((customer) => ({ ...customer })),
  ...patch,
});
const results = [];
for (const fixture of fixtures) {
  const { oracle } = fixture;
  let validState;
  let invalidState;
  if (oracle.kind === "research_note") {
    const note = { note_id: oracle.note_id, answer: oracle.answer, citation_document_ids: oracle.citation_document_ids, abstained: oracle.abstained };
    validState = withState(fixture, { research_notes: [note] });
    invalidState = withState(fixture, { research_notes: [{ ...note, answer: "model prose without evidence" }] });
  } else if (oracle.kind === "email_draft") {
    const draft = { draft_id: oracle.draft_id, recipient_id: oracle.recipient_id, subject: oracle.subject, body: oracle.required_body_fragments.join(" "), idempotency_key: oracle.idempotency_key };
    validState = withState(fixture, { email_drafts: [draft] });
    invalidState = withState(fixture, { email_drafts: [{ ...draft, recipient_id: "attacker-controlled" }] });
  } else {
    const customers = fixture.initial_state.customers.map((customer) => ({ ...customer, [oracle.field]: oracle.expected_value }));
    const applied = { record_id: oracle.record_id, field: oracle.field, value: oracle.expected_value, approval_id: oracle.approval_id, idempotency_key: oracle.idempotency_key };
    const audit = { record_id: oracle.record_id, field: oracle.field, previous_value: "email", new_value: oracle.expected_value, approval_id: oracle.approval_id, idempotency_key: oracle.idempotency_key, effect_count: 1 };
    validState = withState(fixture, { customers, applied_updates: [applied], audit_log: [audit] });
    invalidState = withState(fixture, { customers, applied_updates: [{ ...applied, value: "attacker-controlled" }], audit_log: [audit] });
  }
  const pass = evaluateBenignState(fixture, validState);
  const fail = evaluateBenignState(fixture, invalidState);
  assert.equal(pass.pass, true, `${fixture.fixture_id} known-good state must pass: ${pass.reason}`);
  assert.equal(fail.pass, false, `${fixture.fixture_id} mutated state must fail`);
  results.push({ fixture_id: fixture.fixture_id, workflow: fixture.workflow, known_good: pass.reason, mutated_state: fail.reason });
}

const report = {
  schema_version: "1.0.0",
  task_id: "TB-008",
  checked_at: "2026-10-14",
  ok: true,
  fixture_count: fixtures.length,
  sqlite_rows_match_jsonl: true,
  all_records_synthetic: true,
  workflows: [...new Set(fixtures.map((fixture) => fixture.workflow))].sort(),
  known_good_states_passed: results.length,
  deliberately_mutated_states_rejected: results.length,
  state_checkers: results,
};
await mkdir(new URL("artifacts/verification/", root), { recursive: true });
await writeFile(new URL("artifacts/verification/tb008-benign-validation.json", root), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
