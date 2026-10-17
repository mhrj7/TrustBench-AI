import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

// Storage root (docs/storage-policy.md): /Volumes/MHRJ on the reference machine; a container or another machine sets
// TRUSTBENCH_STORAGE_ROOT (TB-037) and keeps the same layout under it.
const storageRoot = path.resolve(process.env.TRUSTBENCH_STORAGE_ROOT ?? "/Volumes/MHRJ"); // normalised: CI passes "<workspace>/.."
const projectRoot = await realpath(process.cwd());
assert.ok(
  projectRoot.startsWith(`${storageRoot}/`),
  `Project must run from ${storageRoot}, received ${projectRoot}`,
);

const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
assert.equal(process.version, `v${packageJson.engines.node}`);
const effectiveNpmCache = execFileSync("npm", ["config", "get", "cache"], {
  encoding: "utf8",
}).trim();
assert.equal(path.resolve(effectiveNpmCache), path.join(storageRoot, ".cache/npm"));

const Fixture = z.object({
  fixture_version: z.literal("1.0.0"),
  fixture_id: z.literal("smoke-environment-001"),
  synthetic: z.literal(true),
  tenant_id: z.literal("tenant-smoke"),
  workflow: z.literal("document_evidence_analyst"),
  task: z.object({
    question: z.string().min(1),
    allowed_document_ids: z.array(z.string()).min(1),
    allowed_tools: z.array(z.enum(["search_documents", "read_document"])).length(2),
  }),
  documents: z.array(z.object({
    document_id: z.string(),
    tenant_id: z.string(),
    content: z.string(),
  })).length(1),
  expected: z.object({
    answer: z.literal("Silver"),
    citation_document_ids: z.array(z.literal("doc-smoke-001")).length(1),
    state_changes: z.literal(0),
  }),
});

const fixturePath = path.join(projectRoot, "fixtures/smoke/environment.json");
const fixtureBytes = await readFile(fixturePath);
const fixture = Fixture.parse(JSON.parse(fixtureBytes.toString("utf8")));
const document = fixture.documents[0];

assert.equal(document.tenant_id, fixture.tenant_id);
assert.ok(fixture.task.allowed_document_ids.includes(document.document_id));
assert.match(document.content, /Project Cedar.*Silver/);
assert.equal(fixture.expected.state_changes, 0);

const digest = createHash("sha256").update(fixtureBytes).digest("hex");
console.log(JSON.stringify({
  ok: true,
  fixture_id: fixture.fixture_id,
  synthetic: fixture.synthetic,
  credentials_required: false,
  state_changes: fixture.expected.state_changes,
  fixture_sha256: digest,
}));
