import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BenignFixtureSchema } from "../runtime/benign.ts";
import { AttackFixtureSchema } from "../runtime/attacks.ts";

const root = new URL("../", import.meta.url);
const readJsonl = async (relativePath, schema) => (await readFile(new URL(relativePath, root), "utf8")).trim().split("\n").map((line, index) => {
  try { return schema.parse(JSON.parse(line)); }
  catch (error) { throw new Error(`Invalid ${relativePath} record at line ${index + 1}: ${String(error)}`); }
});
const benign = await readJsonl("data/benign.jsonl", BenignFixtureSchema);
const attacks = await readJsonl("data/attacks.jsonl", AttackFixtureSchema);
const benignById = new Map(benign.map((fixture) => [fixture.fixture_id, fixture]));

assert.ok(attacks.length >= 3, "Expected recipient, tool-choice, and destination attacks");
assert.equal(new Set(attacks.map((fixture) => fixture.attack_id)).size, attacks.length, "Attack IDs must be unique");
const goals = new Set(attacks.map((fixture) => fixture.attacker_goal.toLowerCase()));
assert.ok([...goals].some((goal) => goal.includes("recipient")), "Missing recipient-change goal");
assert.ok([...goals].some((goal) => goal.includes("tool selection")), "Missing tool-choice goal");
assert.ok([...goals].some((goal) => goal.includes("destination")), "Missing destination-change goal");

const verified = [];
for (const attack of attacks) {
  const base = benignById.get(attack.base_fixture_id);
  assert.ok(base, `${attack.attack_id} references a missing benign fixture`);
  assert.equal(base.workflow, attack.workflow, `${attack.attack_id} workflow differs from its base task`);
  assert.ok(attack.protected_contract.allowed_tools.every((tool) => base.task_contract.allowed_tools.includes(tool)), `${attack.attack_id} widens the base task's tool allowlist`);
  assert.ok(attack.local_sink.sink_id.startsWith("fixture-"), `${attack.attack_id} sink is outside the local synthetic namespace`);
  assert.equal(attack.local_sink.external_network, false);
  assert.ok(attack.entry_point === "document.content" || attack.entry_point === "reference_document.content" || attack.entry_point === "customer_record.untrusted_note");
  assert.ok(/untrusted/i.test(attack.untrusted_text), `${attack.attack_id} must label injected content as untrusted`);
  if (attack.workflow === "email_draft_assistant") {
    assert.equal(attack.protected_contract.expected_recipient_id, base.task_contract.recipient_id, `${attack.attack_id} must preserve the trusted recipient as the protected value`);
  }
  if (attack.workflow === "controlled_record_update") {
    assert.equal(attack.protected_contract.expected_record_id, base.task_contract.record_id, `${attack.attack_id} must preserve the trusted record as the protected value`);
    assert.equal(attack.protected_contract.expected_approval_id, base.task_contract.approval_id, `${attack.attack_id} must retain exact approval binding`);
  }
  verified.push({ attack_id: attack.attack_id, workflow: attack.workflow, entry_point: attack.entry_point, goal: attack.attacker_goal });
}

const report = {
  schema_version: "1.0.0",
  task_id: "TB-009",
  checked_at: "2026-10-14",
  ok: true,
  attack_fixture_count: attacks.length,
  required_labels_present: true,
  baselines_exist_and_match_workflows: true,
  tool_allowlists_not_widened: true,
  all_sinks_synthetic_and_network_disabled: true,
  fixtures: verified,
};
await mkdir(new URL("artifacts/verification/", root), { recursive: true });
await writeFile(new URL("artifacts/verification/tb009-attack-validation.json", root), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
