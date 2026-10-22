// TB-060: conformance of the external agent, end to end with a mock model. The TB-012 smoke suite runs through goose and
// through the built-in agent; scripts/check-external-smoke.py then checks the goose run's report schema, validity rules,
// evaluator verdicts (equal to the built-in agent's), TB-004 traces, contract checks, spans (every run of both arms, model
// spans present) and redaction (no seeded sensitive value, no credential). A second test proves the checker catches a run
// whose spans lack model calls. Skipped, with the reason, when TRUSTBENCH_GOOSE_BIN is not set.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const agents = JSON.parse(readFileSync(path.join(root, "configs/external-agents.yaml"), "utf8"));
const skip = process.env[agents.agents.goose.binary_env] ? false : `set ${agents.agents.goose.binary_env} to the pinned goose binary`;
const python = path.join(root, ".venv-tools/bin/python");

async function smoke(agent: string, dir: string) {
  const out = path.join(dir, `out-${agent}`), work = path.join(dir, `work-${agent}`);
  await run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/run-arm-smoke.mjs", "--agent", agent, "--defended-system", "gateway_capability",
    "--work-dir", work, "--out-dir", out], { cwd: root, maxBuffer: 64 << 20, timeout: 600_000 });
  if (existsSync(path.join(work, "traces"))) cpSync(path.join(work, "traces"), path.join(out, "traces"), { recursive: true });
  return out;
}

test("conformance: the smoke suite through goose passes every end-to-end check", { skip, timeout: 900_000 }, async () => {
  const dir = await mkdtemp(path.join(root, ".tool-state", "tb060-"));
  const goose = await smoke("goose", dir), builtin = await smoke("trustbench", dir);
  const out = path.join(dir, "check.json");
  const r = await run(python, ["scripts/check-external-smoke.py", "--run", `conformance=${goose}`, "--compare", `builtin=${builtin}`, "--out", out], { cwd: root }).catch((e) => e);
  const check = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(check.ok, true, JSON.stringify(check.runs[0].problems));
  const c = check.runs[0];
  assert.equal(c.valid_pairs, c.pairs);
  assert.ok(c.spans.model > 0 && c.spans.runs === 2 * c.pairs, "model spans present, every run of both arms spanned");
  assert.equal(c.verdicts_vs_builtin.different.length, 0);
  assert.equal(r.code ?? 0, 0);
  await rm(dir, { recursive: true, force: true });
});

test("checker control: a run whose spans lack model calls fails", { skip, timeout: 900_000 }, async () => {
  const dir = await mkdtemp(path.join(root, ".tool-state", "tb060-ctl-"));
  const goose = await smoke("goose", dir);
  const spans = path.join(goose, "spans.jsonl");
  writeFileSync(spans, readFileSync(spans, "utf8").split("\n").filter((l) => !l.includes('"model.call"')).join("\n"));
  const r = await run(python, ["scripts/check-external-smoke.py", "--run", `stripped=${goose}`], { cwd: root }).catch((e) => e);
  assert.notEqual(r.code ?? 0, 0, "the checker must reject spans without model calls");
  assert.match(String(r.stdout), /no model spans/);
  await rm(dir, { recursive: true, force: true });
});
