#!/usr/bin/env node
// TB-057: download the pinned goose release for this platform, verify the archive against the digest GitHub publishes
// (configs/external-agents.yaml) and the extracted binary against its pinned checksum, and install it unchanged.
//   node scripts/fetch-goose.mjs --dest /opt/goose      -> /opt/goose/goose ; set TRUSTBENCH_GOOSE_BIN to it
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const agent = JSON.parse(readFileSync(path.join(root, "configs/external-agents.yaml"), "utf8")).agents.goose;
const i = process.argv.indexOf("--dest");
if (i < 0 || !process.argv[i + 1]) { console.error("usage: fetch-goose.mjs --dest <dir>"); process.exit(2); }
const dest = path.resolve(process.argv[i + 1]);
const key = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const artifact = agent.artifacts[key];
if (!artifact?.binary_sha256) { console.error(`no pinned goose artifact for ${key}`); process.exit(1); }
const sha = (b) => createHash("sha256").update(b).digest("hex");
const url = agent.release_url.replace("{tag}", agent.tag).replace("{archive}", artifact.archive);
const res = await fetch(url);
if (!res.ok) { console.error(`download failed: ${res.status} ${url}`); process.exit(1); }
const archive = Buffer.from(await res.arrayBuffer());
if (sha(archive) !== artifact.archive_sha256) { console.error("archive checksum differs from the published digest"); process.exit(1); }
const tmp = mkdtempSync(path.join(os.tmpdir(), "goose-"));
try {
  writeFileSync(path.join(tmp, artifact.archive), archive);
  execFileSync("tar", ["-xjf", path.join(tmp, artifact.archive), "-C", tmp]);
  const bin = path.join(tmp, "goose");
  if (sha(readFileSync(bin)) !== artifact.binary_sha256) { console.error("binary checksum differs from the pinned one"); process.exit(1); }
  mkdirSync(dest, { recursive: true });
  renameSync(bin, path.join(dest, "goose"));
  chmodSync(path.join(dest, "goose"), 0o755);
  console.log(JSON.stringify({ goose: agent.version, platform: key, path: path.join(dest, "goose"), binary_sha256: artifact.binary_sha256 }));
} finally { rmSync(tmp, { recursive: true, force: true }); }
