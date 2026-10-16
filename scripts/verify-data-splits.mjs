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
  assert.ok(["tuning", "holdout", "holdout2"].includes(group.split), `${group.group_id} has invalid split`);
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
  // A-026: holdout-2 may reuse a family from another split only when it declares the reuse.
  assert.ok(group.split === "holdout2" || !group.reused_attack_family_ids, `${group.group_id}: only holdout-2 groups may reuse attack families`);
  if (group.split === "holdout2") assert.ok(["new", "holdout1_family", "tuning_family"].includes(group.family_status), `${group.group_id} needs a family_status`);
}
for (const group of split.groups.filter((g) => g.reused_attack_family_ids)) {
  for (const familyId of group.reused_attack_family_ids) {
    const owner = familySplits.get(familyId);
    assert.ok(owner && owner.split !== "holdout2", `${group.group_id} reuses unknown family ${familyId}`);
    assert.equal(owner.split === "tuning" ? "tuning_family" : "holdout1_family", group.family_status, `${group.group_id} family_status disagrees with the reused family's split`);
  }
}
assert.deepEqual([...memberships.keys()].sort(), [...fixtureById.keys()].sort(), "Every baseline and attack fixture must occur exactly once");

for (const attack of attacks) {
  const group = memberships.get(attack.attack_id);
  const baseGroup = memberships.get(attack.base_fixture_id);
  assert.ok(group && baseGroup, `${attack.attack_id} and its benign base must both be assigned`);
  assert.equal(group.group_id, baseGroup.group_id, `${attack.attack_id} must remain grouped with its base task`);
  assert.ok(group.task_template_ids.length > 0, `${attack.attack_id} group needs reviewed task-template labels`);
  assert.ok(group.attack_family_ids.length + (group.reused_attack_family_ids?.length ?? 0) > 0, `${attack.attack_id} group needs a semantic attack-family label`);
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
// Holdout-2 (A-026) is a separate sealed set; the registered 80/20 split concerns the core groups only.
const holdout2Ids = split.groups.filter((group) => group.split === "holdout2").flatMap((group) => group.fixture_ids).sort();
if (holdout2Ids.length || split.holdout2_manifest) {
  assert.deepEqual(split.holdout2_manifest.fixture_ids, holdout2Ids, "holdout2_manifest must list every holdout-2 fixture exactly once in sorted order");
  assert.equal(split.holdout2_manifest.sha256, createHash("sha256").update(JSON.stringify(holdout2Ids)).digest("hex"), "holdout2_manifest hash is stale or incorrect");
}
const coreGroups = split.groups.filter((group) => group.split !== "holdout2");
const fixtureCount = fixtureById.size - holdout2Ids.length;
const holdoutCount = holdoutFixtureIds.length;
const holdoutFractionByRows = holdoutCount / fixtureCount;
const holdoutFractionByGroups = coreGroups.filter((group) => group.split === "holdout").length / coreGroups.length;
// The target fraction comes from the registered protocol; the tolerance is declared in the split manifest because the
// fixture count is small and cannot hit the target exactly.
const registry = JSON.parse(await readFile(new URL("protocol/experiment-registry.yaml", root), "utf8"));
const target = registry.holdout.holdout_fraction;
const tolerance = split.holdout_fraction_tolerance;
assert.ok(typeof tolerance === "number" && tolerance >= 0 && tolerance <= 0.1, "Split manifest must declare a holdout_fraction_tolerance of at most 0.1");
assert.ok(Math.abs(holdoutFractionByRows - target) <= tolerance + 1e-9, `Holdout row share ${holdoutFractionByRows} must be within ${tolerance} of the registered ${target}`);
assert.ok(Math.abs(holdoutFractionByGroups - target) <= tolerance + 1e-9, `Holdout group share ${holdoutFractionByGroups} must be within ${tolerance} of the registered ${target}`);

const report = {
  schema_version: "1.0.0",
  task_id: "TB-010",
  split_id: split.split_id,
  checked_at: new Date().toISOString().slice(0, 10),
  registered_holdout_fraction: target,
  holdout_fraction_tolerance: tolerance,
  ok: true,
  fixture_count: fixtureCount,
  group_count: coreGroups.length,
  holdout2_fixture_count: holdout2Ids.length,
  holdout2_manifest_sha256: split.holdout2_manifest?.sha256 ?? null,
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
