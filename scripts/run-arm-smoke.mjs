// Runs identical scripted trajectories through the baseline and defended arms (TB-024).
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBaselineAgent } from "../src/agent/index.ts";
import { MockModelAdapter } from "../src/models/index.ts";
import { buildArm, configDifferences, loadArm, snapshotEpisode } from "../src/arms/arms.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".tool-state/arms-smoke");
const python = path.join(root, ".venv-tools/bin/python");
const suite = JSON.parse(await readFile(path.join(root, "tests/arms/smoke-cases.json"), "utf8"));

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const fixturesPath = path.join(work, "fixtures.jsonl");
await snapshotEpisode("src.arms.cli", ["materialize", "--out", fixturesPath]);
const fixtures = new Map((await readFile(fixturesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).map((row) => [row.fixture_id, row]));

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function waitFor(port) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`server on ${port} did not start`);
}
const children = [];
function launch(args, env) {
  const child = spawn(python, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  child.getStderr = () => stderr;
  children.push(child);
  return child;
}
const stopAll = () => { for (const c of children) c.kill("SIGTERM"); };
process.on("exit", stopAll);

const outcomeFor = (id, calls, text, finish) => ({
  response_id: `response-${id}`, response_model: "mock-arm-smoke-v1", output_text: text,
  tool_calls: calls, usage: { input_tokens: 400, output_tokens: 40, total_tokens: 440 }, finish_reason: finish,
});
function scriptedOutcomes(testCase) {
  const outcomes = testCase.steps.map((step, index) => outcomeFor(`${testCase.case_id}-${index}`,
    [{ call_id: `call-${index + 1}`, tool_name: step.tool, arguments: step.arguments }], "", "tool_call"));
  outcomes.push(outcomeFor(`${testCase.case_id}-final`, [], testCase.final_text, "stop"));
  return outcomes;
}

async function evaluate(fixtureId, attackId, snapshot, result) {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = execFile(python, ["-m", "src.arms.cli", "evaluate", "--fixtures", fixturesPath], { cwd: root }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ fixture_id: fixtureId, attack_id: attackId, final_state: snapshot.state, tool_records: result.tool_records.map((r) => ({ call_id: r.call_id, tool_name: r.tool_name, status: r.status, arguments: r.arguments, state_change_ids: r.state_change_ids, error_code: r.error_code })) }));
  });
}

// Baseline service: one process, one database.
const baselineDb = path.join(work, "baseline.sqlite");
const baselinePort = await freePort();
const baselineEnv = { TRUSTBENCH_FIXTURE_PATH: fixturesPath, TRUSTBENCH_TOOL_DB: baselineDb };
launch(["-m", "uvicorn", "src.tools.app:app", "--host", "127.0.0.1", "--port", String(baselinePort), "--log-level", "warning"], baselineEnv);
await waitFor(baselinePort);

const defendedDb = path.join(work, "defended.sqlite");
const defendedEnv = { TRUSTBENCH_FIXTURE_PATH: fixturesPath, TRUSTBENCH_TOOL_DB: defendedDb };
const traces = [];
const cases = [];

for (const testCase of suite.cases) {
  const fixture = fixtures.get(testCase.fixture_id);
  const episodeId = `arm-smoke-${testCase.case_id}`;
  const taskId = fixture.fixture_id.split("--")[0];
  const arms = {};

  for (const arm of ["baseline", "defended"]) {
    const adapter = new MockModelAdapter("mock-arm-smoke", scriptedOutcomes(testCase));
    let built, port, session, auditFile, approvalLog = [], dbPath;
    if (arm === "baseline") {
      port = baselinePort; dbPath = baselineDb;
      const reset = await fetch(`http://127.0.0.1:${port}/v1/episodes/${episodeId}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixture_id: testCase.fixture_id, max_tool_calls: 12 }) });
      if (!reset.ok) throw new Error(`reset failed ${reset.status}`);
      built = await buildArm({ arm, fixture, episodeId, runId: `run-${testCase.case_id}`, taskId, baseUrl: `http://127.0.0.1:${port}` });
    } else {
      port = await freePort(); dbPath = defendedDb;
      const sessionFile = path.join(work, `session-${testCase.case_id}.json`);
      auditFile = path.join(work, `audit-${testCase.case_id}.jsonl`);
      launch(["-m", "src.gateway.serve", "--fixture", testCase.fixture_id, "--episode", episodeId, "--session-file", sessionFile, "--port", String(port), "--audit-file", auditFile], defendedEnv);
      await waitFor(port);
      session = JSON.parse(await readFile(sessionFile, "utf8"));
      built = await buildArm({ arm, fixture, episodeId, runId: `run-${testCase.case_id}`, taskId, baseUrl: `http://127.0.0.1:${port}`,
        gateway: { sessionToken: session.sessionToken, sessionFile, fixtureId: testCase.fixture_id, checkpointDb: path.join(work, `checkpoints-${testCase.case_id}.sqlite`), env: defendedEnv, approvalLog } });
    }
    const result = await runBaselineAgent({ config: built.config, adapter, tools: built.tools, budgetConfig: built.budget });
    const snapshot = await snapshotEpisode("src.arms.cli", ["snapshot", "--db", dbPath, "--episode", episodeId]);
    const evaluation = await evaluate(testCase.fixture_id, testCase.attack_id, snapshot, result);
    const decisions = auditFile ? (await readFile(auditFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    arms[arm] = { result, requests: adapter.requests, snapshot, evaluation, decisions, approvalLog, configEpisode: built.config };
  }
  cases.push({ testCase, arms });
}
stopAll();

// ---- parity analysis ----
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x));
const parseResults = (requests) => requests.map((r) => r.messages.filter((m) => m.content.startsWith('{"call_id"') || m.content.includes('"type":"tool_result"')).map((m) => JSON.parse(m.content)));
const report = { schema_version: "1.0.0", task_id: "TB-024", checked_at: new Date().toISOString(), model: "scripted local mock (no provider calls)", cases: [] };
const baselineArm = await loadArm("baseline"), defendedArm = await loadArm("defended");
report.config_differences = configDifferences(baselineArm, defendedArm);

for (const { testCase, arms } of cases) {
  const { baseline, defended } = arms;
  const entry = { case_id: testCase.case_id, kind: testCase.kind, fixture_id: testCase.fixture_id };
  entry.run_config_identical = JSON.stringify(baseline.configEpisode) === JSON.stringify(defended.configEpisode);
  entry.first_request_identical = JSON.stringify(baseline.requests[0]) === JSON.stringify(defended.requests[0]);
  entry.settings_identical = baseline.requests.every((r, i) => JSON.stringify(r.settings) === JSON.stringify(defended.requests[i]?.settings ?? r.settings));
  // Compare tool records one-to-one; unwrap the defended provenance envelope.
  const diffs = [];
  const n = Math.max(baseline.result.tool_records.length, defended.result.tool_records.length);
  for (let i = 0; i < n; i++) {
    const b = baseline.result.tool_records[i], d = defended.result.tool_records[i];
    if (!b || !d) { diffs.push({ index: i, tool: (b ?? d).tool_name, kind: "missing_record" }); continue; }
    const unwrapped = d.output && typeof d.output === "object" && "payload" in d.output ? d.output.payload : d.output;
    const same = b.tool_name === d.tool_name && b.status === d.status && b.error_code === d.error_code
      && canon(b.arguments) === canon(d.arguments) && canon(b.output) === canon(unwrapped);
    if (!same) diffs.push({ index: i, tool: d.tool_name, baseline_status: b.status, defended_status: d.status, baseline_error: b.error_code, defended_error: d.error_code });
  }
  entry.record_differences = diffs;
  // Every divergence must be explained by a gateway deny decision for the same tool and call order.
  entry.differences_attributable_to_gateway = diffs.every((x) => defended.decisions.some((dec) => dec.tool === x.tool && dec.decision === "deny"));
  const nonTool = (requests) => requests.map((r) => r.messages.filter((m) => !m.content.includes('"type":"tool_result"')));
  entry.non_tool_messages_identical = canon(nonTool(baseline.requests).slice(0, Math.min(baseline.requests.length, defended.requests.length)))
    === canon(nonTool(defended.requests).slice(0, Math.min(baseline.requests.length, defended.requests.length)));
  entry.same_tool_call_sequence = canon(baseline.result.tool_records.map((r) => [r.tool_name, r.arguments])) === canon(defended.result.tool_records.map((r) => [r.tool_name, r.arguments]));
  entry.baseline = { outcome: baseline.result.outcome, tool_calls: baseline.result.tool_records.length, failures: baseline.result.failures.map((f) => f.code), final_tool_calls: baseline.snapshot.tool_calls, evaluation: baseline.evaluation };
  entry.defended = { outcome: defended.result.outcome, tool_calls: defended.result.tool_records.length, failures: defended.result.failures.map((f) => f.code), final_tool_calls: defended.snapshot.tool_calls, evaluation: defended.evaluation, policy_decisions: defended.decisions.map((x) => ({ seq: x.seq, tool: x.tool, decision: x.decision, reason: x.reason ?? null, status: x.status ?? null, executed: x.executed ?? null, replayed: x.replayed ?? false, request_id: x.request_id ?? null })), approvals: defended.approvalLog };
  entry.final_state_identical = JSON.stringify(baseline.snapshot.state) === JSON.stringify(defended.snapshot.state);
  for (const decision of defended.decisions) traces.push({ case_id: testCase.case_id, arm: "defended", ...decision });
  report.cases.push(entry);
}
await mkdir(path.join(root, "reports"), { recursive: true });
await writeFile(path.join(root, "reports/tb024-policy-decision-traces.jsonl"), traces.map((t) => JSON.stringify(t)).join("\n") + "\n");
await writeFile(path.join(root, "evidence/tb024-defended-arm-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ config_differences: report.config_differences, cases: report.cases.map((c) => ({ id: c.case_id, base: c.baseline.outcome, def: c.defended.outcome, run_cfg: c.run_config_identical, req0: c.first_request_identical, diffs: c.record_differences.length, attributable: c.differences_attributable_to_gateway, state_same: c.final_state_identical, b_eval: [c.baseline.evaluation.utility_pass, c.baseline.evaluation.security_pass], d_eval: [c.defended.evaluation.utility_pass, c.defended.evaluation.security_pass] })) }, null, 1));
const failed = report.cases.flatMap((c) => [
  ["run_config_identical", c.run_config_identical], ["first_request_identical", c.first_request_identical], ["settings_identical", c.settings_identical],
  ["non_tool_messages_identical", c.non_tool_messages_identical], ["same_tool_call_sequence", c.same_tool_call_sequence],
  ["final_state_identical", c.final_state_identical], ["differences_attributable_to_gateway", c.differences_attributable_to_gateway],
].filter(([, ok]) => !ok).map(([name]) => `${c.case_id}:${name}`));
if (failed.length) { console.error("ARM PARITY FAILURES", failed); process.exit(1); }
process.exit(0);
