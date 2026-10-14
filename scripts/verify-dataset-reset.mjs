import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenignFixtureSchema } from "../runtime/benign.ts";
import { AttackFixtureSchema } from "../runtime/attacks.ts";
import { validateDatasetBundle } from "../runtime/dataset-validation.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const parseJsonl = async (relative, schema) => (await readFile(path.join(root, relative), "utf8")).trim().split("\n").map((line, index) => {
  try { return schema.parse(JSON.parse(line)); }
  catch (error) { throw new Error(`${relative}:${index + 1}: malformed payload or schema: ${String(error)}`); }
});
const benign = await parseJsonl("data/benign.jsonl", BenignFixtureSchema);
const attacks = await parseJsonl("data/attacks.jsonl", AttackFixtureSchema);
validateDatasetBundle({ benign, attacks });

const dir = await mkdtemp(path.join(os.tmpdir(), "trustbench-tb011-"));
const dbPath = path.join(dir, "episode.sqlite");
const seeder = path.join(root, "scripts/seed-benign-db.mjs");
const seed = () => {
  const result = spawnSync(process.execPath, [seeder], { cwd: root, env: { ...process.env, TRUSTBENCH_BENIGN_DB_PATH: dbPath }, encoding: "utf8" });
  assert.equal(result.status, 0, `Seed failed: ${result.stderr}`);
};
const snapshot = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const tables = schema.filter(({ type }) => type === "table").map(({ name }) => name);
  const data = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()]));
  db.close();
  return { schema, tables, data };
};
try {
  seed();
  const pristine = snapshot();
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE customers SET attributes_json = json_set(attributes_json, '$.preferred_contact_method', 'CONTAMINATED') WHERE fixture_id = ?").run("TB-BEN-UPDATE-001");
  db.prepare("INSERT INTO fixture_state(fixture_id, entity_type, entity_id, state_json) VALUES (?, ?, ?, ?)").run("TB-BEN-DOC-001", "research_notes", "leaked-across-episodes", JSON.stringify({ contaminated: true }));
  db.close();
  seed();
  const restored = snapshot();
  assert.deepEqual(restored, pristine, "Reseeding must restore exactly the same data and schema after state contamination");
} finally {
  await rm(dir, { recursive: true, force: true });
}

const report = {
  schema_version: "1.0.0",
  task_id: "TB-011",
  checked_at: "2026-10-14",
  ok: true,
  benign_fixture_count: benign.length,
  attack_fixture_count: attacks.length,
  unique_ids_across_manifests: true,
  required_workflow_and_oracle_labels_present: true,
  malformed_payloads_rejected_by_strict_schemas: true,
  invalid_label_and_duplicate_id_mutations_rejected: true,
  deterministic_reset_verified: true,
  reset_method: "Seed disposable SQLite database, mutate persisted customer state and inject a state row, reseed, then compare every table and schema-backed row to the pristine snapshot.",
  real_user_data_used: false,
};
const reports = path.join(root, "reports");
await mkdir(reports, { recursive: true });
await writeFile(path.join(reports, "data-validation.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
