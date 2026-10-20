// TB-059: every development fixture runs end to end through goose with the unchanged evaluators. Scripted trajectories
// make the comparison exact: the same tool calls go through goose and through the built-in agent, so identical evaluator
// verdicts show the fixtures, initial state and evaluators are delivered unchanged. The runner's holdout guard is
// exercised with goose as the agent: a sealed case in the suite is excluded and no sealed fixture is loaded.
// Skipped, with the reason, when TRUSTBENCH_GOOSE_BIN is not set.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const agents = JSON.parse(readFileSync(path.join(root, "configs/external-agents.yaml"), "utf8"));
const gooseBin = process.env[agents.agents.goose.binary_env];
const skip = gooseBin ? false : `set ${agents.agents.goose.binary_env} to the pinned goose binary`;
const suitePath = "tests/external/fixtures/dev-suite.json";

async function runner(agent: string, suite: string, dir: string) {
  await run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/run-arm-smoke.mjs", "--agent", agent, "--defended-system", "gateway_capability",
    "--suite", suite, "--work-dir", path.join(dir, `work-${agent}`), "--out-dir", path.join(dir, `out-${agent}`)], { cwd: root, maxBuffer: 64 << 20, timeout: 600_000 });
  return JSON.parse(readFileSync(path.join(dir, `out-${agent}`, "report.json"), "utf8"));
}

const verdict = (c: any) => Object.fromEntries(["baseline", "defended"].map((arm) => {
  const e = c[arm].evaluation ?? {};
  return [arm, [c[arm].outcome, e.utility_pass, e.security_pass, e.attacker_goal_achieved, [...(e.reason_codes ?? [])].sort(), c[arm].tool_calls]];
}));

test("every development fixture runs end to end through goose; verdicts equal the built-in agent's", { skip, timeout: 900_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tb059-"));
  const builtin = await runner("trustbench", suitePath, dir);
  const goose = await runner("goose", suitePath, dir);
  const suite = JSON.parse(readFileSync(path.join(root, suitePath), "utf8"));
  assert.equal(goose.agent.name, "goose");
  assert.equal(goose.summary.validity.valid_pairs, suite.cases.length, "every case ran end to end");
  const covered = new Set(goose.cases.flatMap((c: any) => [c.fixture_id.split("--")[0], c.attack_id].filter(Boolean)));
  assert.deepEqual([...covered].sort(), [...suite.development_fixture_ids].sort(), "every development fixture was run");
  const byId = new Map(builtin.cases.map((c: any) => [`${c.case_id}:${c.repetition}`, c]));
  for (const c of goose.cases) assert.deepEqual(verdict(c), verdict(byId.get(`${c.case_id}:${c.repetition}`)), `verdicts of ${c.case_id}`);
  for (const c of goose.cases) for (const arm of ["baseline", "defended"]) assert.equal(c[arm].external.trace.valid, true, `${c.case_id} ${arm} trace`);
  assert.equal(goose.sealed_fixtures_loaded, 0);
  await rm(dir, { recursive: true, force: true });
});

test("runner holdout guard with goose: a sealed case is excluded and no sealed fixture is loaded", { skip, timeout: 300_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tb059-guard-"));
  const suite = JSON.parse(readFileSync(path.join(root, suitePath), "utf8"));
  const holdout = JSON.parse(readFileSync(path.join(root, "data/holdout-suite.json"), "utf8")).cases[0];
  const mixed = path.join(dir, "mixed-suite.json");
  writeFileSync(mixed, JSON.stringify({ ...suite, cases: [suite.cases.find((c: any) => c.case_id === "doc-benign"), { ...holdout, steps: [], final_text: "" }] }));
  const report = await runner("goose", mixed, dir);
  assert.deepEqual(report.holdout_excluded_cases, [holdout.case_id], "the sealed case is excluded and listed");
  assert.deepEqual(report.cases.map((c: any) => c.case_id), ["doc-benign"], "goose never ran the sealed case");
  assert.equal(report.sealed_fixtures_loaded, 0, "no sealed fixture was loaded into the run");
  const splits = JSON.parse(readFileSync(path.join(root, "data/splits.json"), "utf8"));
  const sealed = new Set(["holdout_manifest", "holdout2_manifest"].flatMap((k) => splits[k]?.fixture_ids ?? []));
  const loaded = readFileSync(path.join(dir, "work-goose", "fixtures.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).fixture_id);
  assert.ok(loaded.length > 0 && !loaded.some((id: string) => id.split("--").some((p) => sealed.has(p))), "the tool services' fixture file holds no sealed fixture");
  await rm(dir, { recursive: true, force: true });
});
