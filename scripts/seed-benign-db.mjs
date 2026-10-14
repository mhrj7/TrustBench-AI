import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BenignFixtureSchema } from "../runtime/benign.ts";

const root = new URL("../", import.meta.url);
const lines = (await readFile(new URL("data/benign.jsonl", root), "utf8")).trim().split("\n");
const fixtures = lines.map((line, index) => {
  try { return BenignFixtureSchema.parse(JSON.parse(line)); }
  catch (error) { throw new Error(`Invalid benign fixture at line ${index + 1}: ${String(error)}`); }
});
const dbPath = fileURLToPath(new URL("data/benign.sqlite", root));
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; DROP TABLE IF EXISTS fixture_state; DROP TABLE IF EXISTS approvals; DROP TABLE IF EXISTS customers; DROP TABLE IF EXISTS contacts; DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS fixtures;");
db.exec(`
  CREATE TABLE fixtures (
    fixture_id TEXT PRIMARY KEY,
    fixture_version TEXT NOT NULL,
    synthetic INTEGER NOT NULL CHECK (synthetic = 1),
    tenant_id TEXT NOT NULL,
    workflow TEXT NOT NULL,
    task_contract_json TEXT NOT NULL,
    oracle_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE documents (
    fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
    document_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (fixture_id, document_id)
  ) STRICT;
  CREATE TABLE users (
    fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
    user_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    PRIMARY KEY (fixture_id, user_id)
  ) STRICT;
  CREATE TABLE contacts (
    fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
    contact_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    PRIMARY KEY (fixture_id, contact_id)
  ) STRICT;
  CREATE TABLE customers (
    fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
    record_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    attributes_json TEXT NOT NULL,
    PRIMARY KEY (fixture_id, record_id)
  ) STRICT;
  CREATE TABLE approvals (
    fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
    approval_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    single_use INTEGER NOT NULL CHECK (single_use = 1),
    PRIMARY KEY (fixture_id, approval_id)
  ) STRICT;
  CREATE TABLE fixture_state (
    fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state_json TEXT NOT NULL,
    PRIMARY KEY (fixture_id, entity_type, entity_id)
  ) STRICT;
`);

const putFixture = db.prepare("INSERT INTO fixtures VALUES (?, ?, 1, ?, ?, ?, ?)");
const putUser = db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)");
const putDocument = db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)");
const putContact = db.prepare("INSERT INTO contacts VALUES (?, ?, ?, ?, ?)");
const putCustomer = db.prepare("INSERT INTO customers VALUES (?, ?, ?, ?)");
const putApproval = db.prepare("INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, 1)");
const putState = db.prepare("INSERT INTO fixture_state VALUES (?, ?, ?, ?)");

for (const fixture of fixtures) {
  const fid = fixture.fixture_id;
  putFixture.run(fid, fixture.fixture_version, fixture.tenant_id, fixture.workflow, JSON.stringify(fixture.task_contract), JSON.stringify(fixture.oracle));
  for (const row of fixture.initial_state.users) putUser.run(fid, row.user_id, row.tenant_id, row.display_name, row.email);
  for (const row of fixture.initial_state.documents) putDocument.run(fid, row.document_id, row.tenant_id, row.content);
  for (const row of fixture.initial_state.contacts) putContact.run(fid, row.contact_id, row.tenant_id, row.display_name, row.email);
  for (const row of fixture.initial_state.customers) putCustomer.run(fid, row.record_id, row.tenant_id, JSON.stringify(row));
  for (const row of fixture.initial_state.approvals) putApproval.run(fid, row.approval_id, row.tenant_id, row.record_id, JSON.stringify({ field: row.field, value: row.value, idempotency_key: row.idempotency_key }), row.expires_at);
  for (const entityType of ["research_notes", "email_drafts", "sent_emails", "applied_updates", "audit_log"]) {
    for (const [index, row] of fixture.initial_state[entityType].entries()) putState.run(fid, entityType, `${entityType}-${index + 1}`, JSON.stringify(row));
  }
}

db.close();
console.log(JSON.stringify({ database: dbPath, fixtures: fixtures.length }));
