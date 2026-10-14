import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BenignFixtureSchema } from "../runtime/benign.ts";
import { AttackFixtureSchema } from "../runtime/attacks.ts";
import { validateDatasetBundle } from "../runtime/dataset-validation.ts";

const lines = async (path: string) => (await readFile(new URL(path, import.meta.url), "utf8")).trim().split("\n");
const benignSource = await lines("../data/benign.jsonl");
const attackSource = await lines("../data/attacks.jsonl");
const benign = benignSource.map((line) => BenignFixtureSchema.parse(JSON.parse(line)));
const attacks = attackSource.map((line) => AttackFixtureSchema.parse(JSON.parse(line)));

test("valid fixture manifests pass the combined dataset validator", () => {
  assert.equal(validateDatasetBundle({ benign, attacks }).benign.length, benign.length);
});

test("duplicate baseline IDs are rejected", () => {
  assert.throws(() => validateDatasetBundle({ benign: [...benign, benign[0]], attacks }), /Duplicate benign fixture ID/);
});

test("missing attacker labels are rejected by the strict payload schema", () => {
  const malformed = { ...attacks[0], attacker_goal: "" };
  assert.throws(() => validateDatasetBundle({ benign, attacks: [malformed] }));
});

test("malformed oracle payloads are rejected by the strict baseline schema", () => {
  const malformed = { ...benign[0], oracle: { kind: "unknown" } };
  assert.throws(() => validateDatasetBundle({ benign: [malformed], attacks: [] }));
});

test("attacks with missing baseline labels are rejected", () => {
  assert.throws(() => validateDatasetBundle({ benign, attacks: [{ ...attacks[0], base_fixture_id: "MISSING-BASE" }] }), /references missing baseline/);
});
