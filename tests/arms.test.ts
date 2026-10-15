import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildArm, configDifferences, loadArm } from "../src/arms/arms.ts";

const root = path.resolve(import.meta.dirname, "..");
const run = promisify(execFile);

test("effective arm configs differ only in the declared gateway tool path", async () => {
  const baseline = await loadArm("baseline");
  const defended = await loadArm("defended");
  const differences = configDifferences(baseline, defended);
  assert.ok(differences.length > 0);
  assert.ok(!differences.includes("shared"));
  for (const key of differences) assert.ok(defended.allowed_differences.includes(key), `${key} is not an allowed difference`);
  assert.deepEqual(baseline.shared, defended.shared);
});

test("both arms build identical model-facing run configs for every fixture", async () => {
  const rows = (await readFile(path.join(root, "data/benign.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  for (const fixture of rows) {
    const base = { fixture, episodeId: `ep-${fixture.fixture_id}`, runId: "r", taskId: fixture.fixture_id, baseUrl: "http://127.0.0.1:1" };
    const a = await buildArm({ ...base, arm: "baseline" });
    const b = await buildArm({ ...base, arm: "defended", gateway: { sessionToken: "secret-token-value", sessionFile: "/x", fixtureId: fixture.fixture_id, checkpointDb: "/y", env: {} } });
    assert.deepEqual(a.config, b.config);
    assert.deepEqual(a.config.tools.map((t) => t.name), fixture.task_contract.allowed_tools);
    assert.ok(!JSON.stringify(b.config).includes("secret-token-value"), "session token must never reach prompts or tool schemas");
    assert.deepEqual(Object.keys(a.tools).sort(), Object.keys(b.tools).sort());
    assert.deepEqual(a.budget, b.budget);
  }
});

test("defended arm refuses to run without a gateway session", async () => {
  const fixture = JSON.parse((await readFile(path.join(root, "data/benign.jsonl"), "utf8")).split("\n")[0]);
  await assert.rejects(buildArm({ arm: "defended", fixture, episodeId: "e", runId: "r", taskId: "t", baseUrl: "http://127.0.0.1:1" }), /gateway session/);
});

test("smoke cases: identical prompts and state, gateway-only divergence, policy traces recorded", async () => {
  await run("node", ["scripts/run-arm-smoke.mjs"], { cwd: root, maxBuffer: 1 << 24, timeout: 240_000 });
  const report: any = JSON.parse(await readFile(path.join(root, "evidence/tb024-defended-arm-report.json"), "utf8"));
  assert.equal(report.cases.length, 7);
  for (const c of report.cases as any[]) {
    assert.ok(c.run_config_identical && c.first_request_identical && c.settings_identical && c.non_tool_messages_identical, c.case_id);
    assert.ok(c.same_tool_call_sequence && c.final_state_identical && c.differences_attributable_to_gateway, c.case_id);
    assert.ok(c.defended.policy_decisions.length > 0, `${c.case_id} has no policy decision trace`);
    assert.ok(c.defended.policy_decisions.every((d: any) => d.decision && d.tool), c.case_id);
    assert.ok(c.defended.evaluation.security_pass, `${c.case_id} defended security`);
    if (c.kind === "benign") {
      assert.ok(c.baseline.evaluation.utility_pass && c.defended.evaluation.utility_pass, `${c.case_id} benign utility`);
      assert.equal(c.defended.outcome, "success");
      assert.ok(c.defended.policy_decisions.every((d: any) => d.decision !== "deny"));
    }
  }
  const update = report.cases.find((c: any) => c.case_id === "update-benign");
  assert.equal(update.defended.approvals.length, 1);
  assert.equal(update.defended.approvals[0].matched_synthetic_event, true);
  assert.equal(update.defended.final_tool_calls, 3);
  const denied = report.cases.filter((c: any) => c.kind === "attack").flatMap((c: any) => c.defended.policy_decisions).filter((d: any) => d.decision === "deny");
  assert.ok(denied.length >= 3 && denied.every((d: any) => d.reason));
});
