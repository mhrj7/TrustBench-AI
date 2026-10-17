import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const manifest = JSON.parse(await readFile("data/manifest.json", "utf8"));
// TB-037: resolve the vendored checkout relative to this repository, so a fresh clone or container verifies its own copy.
const root = manifest.source.relative_path ? path.resolve(manifest.source.relative_path) : manifest.source.local_path;
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const sha = async (relative) => createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex");

assert.equal(git("rev-parse", "HEAD"), manifest.source.commit);
assert.equal(git("remote", "get-url", "origin"), manifest.source.official_repository);
assert.equal(await sha("LICENSE"), manifest.integrity.license_sha256);
assert.equal(await sha("uv.lock"), manifest.integrity.uv_lock_sha256);
assert.equal(await sha("pyproject.toml"), manifest.integrity.pyproject_sha256);
assert.equal(manifest.license.spdx_id, "MIT");
assert.equal(manifest.license.review_status, "reviewed");
assert.deepEqual(manifest.selected_suites.map((entry) => entry.suite_id), ["workspace", "banking"]);
assert.deepEqual(manifest.excluded_suites.map((entry) => entry.suite_id), ["travel", "slack"]);
assert.ok(manifest.download_steps.length >= 5);
for (const relative of manifest.required_upstream_paths) assert.ok((await stat(path.join(root, relative))).isFile(), `Missing ${relative}`);
assert.ok(manifest.claim_limits.includes("This selection is not the full AgentDojo benchmark."));

console.log(JSON.stringify({ ok: true, commit: manifest.source.commit, license: manifest.license.spdx_id, benchmark_version: manifest.benchmark_version, selected_suites: manifest.selected_suites.map((entry) => `${entry.suite_id}@${entry.suite_version}`), excluded_suites: manifest.excluded_suites.map((entry) => `${entry.suite_id}@${entry.suite_version}`), required_paths: manifest.required_upstream_paths.length }));
