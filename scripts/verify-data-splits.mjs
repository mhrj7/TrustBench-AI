import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BenignFixtureSchema } from "../runtime/benign.ts";
import { AttackFixtureSchema } from "../runtime/attacks.ts";

const root = new URL("../", import.meta.url);
const readJsonl = async (path, schema) => (await readFile(new URL(path, root), "utf8")).trim().split("\n").map((line, index) => {
  try { return schema.parse(JSON.parse(line)); }
  catch (error) { throw new Error(`Invalid ${path} record at line ${index + 1}: ${String(error)}`); }
});
const benign = await readJsonl("data/benign.jsonl", BenignFixtureSchema);
const attacks = await readJsonl("data/attacks.jsonl", AttackFixtureSchema);
const split = JSON.parse(await readFile(new URL("data/splits.json", root), "utf8"));
assert.equal(split.schema_version, "1.0.0");
assert.equal(split.locked, true, "Split manifest must be locked before evaluation");
assert.equal(split.deduplication.semantic_review_complete, true, "Human semantic family review must be declared complete");
assert.equal(split.deduplication.near_duplicate_families_cross_split, false);

const fixtureById = new Map([
  ...benign.map((fixture) => [fixture.fixture_id, { kind: "benign", fixture }]),
  ...attacks.map((fixture) => [fixture.attack_id, { kind: "attack", fixture }]),
]);
assert.equal(fixtureById.size, benign.length + attacks.length, "Fixture identifiers must be globally unique");
const memberships = new Map();
const templateSplits = new Map();
const familySplits = new Map();
const textHashes = new Map();
for (const group of split.groups) {
  assert.ok(["tuning", "holdout"].includes(group.split), `${group.group_id} has invalid split`);
  assert.ok(group.fixture_ids.length > 0, `${group.group_id} cannot be empty`);
  for (const id of group.fixture_ids) {
    assert.ok(fixtureById.has(id), `${group.group_id} references unknown fixture ${id}`);
    assert.ok(!memberships.has(id), `${id} occurs in multiple split groups`);
    memberships.set(id, group);
  }
  for (const templateId of group.task_template_ids) {
    assert.ok(!templateSplits.has(templateId), `Task template ${templateId} crosses groups/splits`);
    templateSplits.set(templateId, { split: group.split, groupId: group.group_id });
  }
  for (const familyId of group.attack_family_ids) {
    assert.ok(!familySplits.has(familyId), `Attack family ${familyId} crosses groups/splits`);
    familySplits.set(familyId, { split: group.split, groupId: group.group_id });
  }
}
assert.deepEqual([...memberships.keys()].sort(), [...fixtureById.keys()].sort(), "Every baseline and attack fixture must occur exactly once");

for (const attack of attacks) {
  const group = memberships.get(attack.attack_id);
  const baseGroup = memberships.get(attack.base_fixture_id);
  assert.ok(group && baseGroup, `${attack.attack_id} and its benign base must both be assigned`);
  assert.equal(group.group_id, baseGroup.group_id, `${attack.attack_id} must remain grouped with its base task`);
  assert.ok(group.task_template_ids.length > 0, `${attack.attack_id} group needs reviewed task-template labels`);
  assert.ok(group.attack_family_ids.length > 0, `${attack.attack_id} group needs a semantic attack-family label`);
  const normalized = attack.untrusted_text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const digest = createHash("sha256").update(normalized).digest("hex");
  const previous = textHashes.get(digest);
  if (previous) assert.equal(previous.split, group.split, `Normalized exact duplicate payload crosses split: ${attack.attack_id}`);
  else textHashes.set(digest, { split: group.split, attackId: attack.attack_id });
}

const holdoutFixtureIds = split.groups.filter((group) => group.split === "holdout").flatMap((group) => group.fixture_ids).sort();
assert.deepEqual(split.holdout_manifest.fixture_ids, holdoutFixtureIds, "Locked holdout manifest must list every holdout fixture exactly once in sorted order");
const holdoutDigest = createHash("sha256").update(JSON.stringify(holdoutFixtureIds)).digest("hex");
assert.equal(split.holdout_manifest.sha256, holdoutDigest, "Locked holdout manifest hash is stale or incorrect");
const fixtureCount = fixtureById.size;
const holdoutCount = holdoutFixtureIds.length;
const holdoutFractionByRows = holdoutCount / fixtureCount;
const holdoutFractionByGroups = split.groups.filter((group) => group.split === "holdout").length / split.groups.length;
assert.ok(Math.abs(holdoutFractionByRows - 0.2) < 1e-9, "Holdout row share must equal the preregistered 20% for this fixture set");
assert.ok(Math.abs(holdoutFractionByGroups - 0.2) < 1e-9, "Holdout group share must equal 20% for this fixture set");

const report = {
  schema_version: "1.0.0",
  task_id: "TB-010",
  checked_at: "2026-10-14",
  ok: true,
  fixture_count: fixtureCount,
  group_count: split.groups.length,
  tuning_fixture_count: fixtureCount - holdoutCount,
  holdout_fixture_count: holdoutCount,
  holdout_fraction_by_rows: holdoutFractionByRows,
  holdout_fraction_by_groups: holdoutFractionByGroups,
  holdout_manifest_sha256: holdoutDigest,
  every_fixture_assigned_once: true,
  base_attack_pairs_stay_together: true,
  task_template_families_stay_within_one_group: true,
  semantic_attack_families_stay_within_one_group: true,
  normalized_exact_duplicates_cross_split: false,
  semantic_review_method: "manual labels recorded in data/splits.json; not automated semantic similarity detection",
};
await mkdir(new URL("artifacts/verification/", root), { recursive: true });
await writeFile(new URL("artifacts/verification/tb010-split-validation.json", root), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
