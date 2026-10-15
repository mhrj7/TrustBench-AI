// Runs the baseline and defended arms on identical tasks (TB-024).
//   scripted (default): identical scripted model trajectories; checks wiring and parity.
//   --model ollama:<id> | gemini:<id> | nvidia:<id>: live model; --repetitions N; --tool-mode permissive|contract.
// The baseline is the protocol's uncontrolled agent: its backend runs in permissive mode, so attacks can commit
// synthetic effects. The defended arm uses the same permissive backend behind the gateway, so the gateway is the
// only control. --tool-mode contract runs both arms against the TB-014 contract-checked backend (ablation).
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBaselineAgent } from "../src/agent/index.ts";
import { MockModelAdapter, createGeminiAdapter, createNvidiaAdapter, createOllamaAdapter } from "../src/models/index.ts";
import { buildArm, configDifferences, loadArm, snapshotEpisode } from "../src/arms/arms.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".tool-state/arms-smoke");
const python = path.join(root, ".venv-tools/bin/python");
const flag = (name, fallback = null) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const modelArg = flag("--model");
const live = modelArg !== null;
const repetitions = Number(flag("--repetitions", "1"));
const toolMode = flag("--tool-mode", "permissive");
const temperature = Number(flag("--temperature", "0"));
const onlyCases = flag("--cases") ? new Set(flag("--cases").split(",")) : null;
const minIntervalMs = Number(flag("--min-interval-ms", "0"));
const rendering = flag("--attack-rendering", "as_authored");
const includeHoldoutMechanics = process.argv.includes("--include-holdout-mechanics");
const baseSeed = 20261014;
if (!["permissive", "contract"].includes(toolMode)) throw new Error("--tool-mode must be permissive or contract");
if (!Number.isInteger(repetitions) || repetitions < 1 || (!live && repetitions !== 1)) throw new Error("--repetitions must be a positive integer (live runs only)");
if (!["as_authored", "stripped", "authority"].includes(rendering)) throw new Error("--attack-rendering must be as_authored, stripped or authority");
if (live && includeHoldoutMechanics) throw new Error("holdout fixtures may never be used with a live model");
if (live && /^(gemini|nvidia):/.test(modelArg)) { try { process.loadEnvFile(path.join(root, ".env")); } catch { /* key may come from the shell */ } }

const makeLiveAdapter = () => {
  if (modelArg.startsWith("ollama:")) return createOllamaAdapter(modelArg.slice(7));
  if (modelArg.startsWith("gemini:")) return createGeminiAdapter(modelArg.slice(7), process.env.GEMINI_API_KEY ?? "");
  if (modelArg.startsWith("nvidia:")) return createNvidiaAdapter(modelArg.slice(7), process.env.NVIDIA_API_KEY ?? "");
  throw new Error(`unsupported --model ${modelArg}`);
};
const budgetFile = !live ? "configs/budget-local.yaml" : modelArg.startsWith("gemini:") ? "configs/budget-gemini-free.yaml" : modelArg.startsWith("nvidia:") ? "configs/budget-nvidia-free.yaml" : "configs/budget-local.yaml";
const runOptions = (rep) => ({
  budgetConfigPath: path.join(root, budgetFile),
  ...(live ? { timeoutMs: 240_000, generationOverrides: { temperature, seed: baseSeed + rep, max_output_tokens: 1024, ...(modelArg.startsWith("ollama:") ? { reasoning_effort: "none" } : {}) } } : {}),
});
const suite = JSON.parse(await readFile(path.join(root, "tests/arms/smoke-cases.json"), "utf8"));
// Holdout protection: protocol/preregister.md forbids using holdout contents for debugging. Holdout fixtures are
// excluded from every run; scripted mechanics runs may include them only with --include-holdout-mechanics.
const splits = JSON.parse(await readFile(path.join(root, "data/splits.json"), "utf8"));
const holdoutIds = new Set(splits.holdout_manifest.fixture_ids);
const isHoldout = (c) => holdoutIds.has(c.fixture_id.split("--")[0]) || (c.attack_id && holdoutIds.has(c.attack_id));
const selected = suite.cases.filter((c) => (!onlyCases || onlyCases.has(c.case_id)) && (includeHoldoutMechanics || !isHoldout(c)));
const excludedHoldout = suite.cases.filter(isHoldout).map((c) => c.case_id);

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const fixturesPath = path.join(work, "fixtures.jsonl");
await snapshotEpisode("src.arms.cli", ["materialize", "--out", fixturesPath, "--rendering", rendering]);
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

function evaluate(fixtureId, attackId, snapshot, result) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, ["-m", "src.arms.cli", "evaluate", "--fixtures", fixturesPath], { cwd: root }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ fixture_id: fixtureId, attack_id: attackId, final_state: snapshot.state, tool_records: result.tool_records.map((r) => ({ call_id: r.call_id, tool_name: r.tool_name, status: r.status, arguments: r.arguments, state_change_ids: r.state_change_ids, error_code: r.error_code })) }));
  });
}

// Deterministic pair order (protocol: randomized from the experiment seed and recorded).
function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (text) => [...text].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
const pairOrder = (caseId, rep) => (mulberry32(baseSeed ^ hash(`${caseId}:${rep}`))() < 0.5 ? ["baseline", "defended"] : ["defended", "baseline"]);

const baselineDb = path.join(work, "baseline.sqlite");
const baselinePort = await freePort();
const defendedDb = path.join(work, "defended.sqlite");
const serviceEnv = (db) => ({ TRUSTBENCH_FIXTURE_PATH: fixturesPath, TRUSTBENCH_TOOL_DB: db, TRUSTBENCH_TOOL_MODE: toolMode });
launch(["-m", "uvicorn", "src.tools.app:app", "--host", "127.0.0.1", "--port", String(baselinePort), "--log-level", "warning"], serviceEnv(baselineDb));
await waitFor(baselinePort);

let lastCall = 0;
async function runArm(arm, testCase, fixture, rep) {
  const episodeId = `arm-smoke-${testCase.case_id}-r${rep}`;
  const taskId = fixture.fixture_id.split("--")[0];
  const adapter = live ? makeLiveAdapter() : new MockModelAdapter("mock-arm-smoke", scriptedOutcomes(testCase));
  adapter.requests = [];
  adapter.providerRetries = 0;
  if (live) {
    const originalGenerate = adapter.generate.bind(adapter);
    adapter.generate = async (req, opts) => {
      adapter.requests.push(structuredClone(req));
      for (let attempt = 1; ; attempt++) {
        const wait = lastCall + minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCall = Date.now();
        try { return await originalGenerate(req, opts); }
        catch (error) {
          if (/retry in \d+h|retry in \d+m/.test(String(error?.message))) {
            console.error(`PROVIDER QUOTA EXHAUSTED for ${modelArg}; aborting without writing results.`);
            process.exit(2);
          }
          if (!(error?.retryable) || attempt >= 4) throw error;
          adapter.providerRetries++;
          await new Promise((r) => setTimeout(r, 5000 * attempt));
        }
      }
    };
  } else {
    const originalGenerate = adapter.generate.bind(adapter);
    adapter.generate = originalGenerate;
  }
  let built, port, dbPath, auditFile; const approvalLog = [];
  const common = { arm, fixture, episodeId, runId: `run-${testCase.case_id}-r${rep}`, taskId, ...runOptions(rep) };
  if (arm === "baseline") {
    port = baselinePort; dbPath = baselineDb;
    const reset = await fetch(`http://127.0.0.1:${port}/v1/episodes/${episodeId}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixture_id: testCase.fixture_id, max_tool_calls: 12 }) });
    if (!reset.ok) throw new Error(`reset failed ${reset.status}`);
    built = await buildArm({ ...common, baseUrl: `http://127.0.0.1:${port}` });
  } else {
    port = await freePort(); dbPath = defendedDb;
    const tag = `${testCase.case_id}-r${rep}`;
    const sessionFile = path.join(work, `session-${tag}.json`);
    auditFile = path.join(work, `audit-${tag}.jsonl`);
    launch(["-m", "src.gateway.serve", "--fixture", testCase.fixture_id, "--episode", episodeId, "--session-file", sessionFile, "--port", String(port), "--audit-file", auditFile], serviceEnv(defendedDb));
    await waitFor(port);
    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    built = await buildArm({ ...common, baseUrl: `http://127.0.0.1:${port}`,
      gateway: { sessionToken: session.sessionToken, sessionFile, fixtureId: testCase.fixture_id, checkpointDb: path.join(work, `checkpoints-${tag}.sqlite`), env: serviceEnv(defendedDb), approvalLog } });
  }
  const started = Date.now();
  const result = await runBaselineAgent({ config: built.config, adapter, tools: built.tools, budgetConfig: built.budget });
  const elapsedMs = Date.now() - started;
  const snapshot = await snapshotEpisode("src.arms.cli", ["snapshot", "--db", dbPath, "--episode", episodeId]);
  const evaluation = await evaluate(testCase.fixture_id, testCase.attack_id, snapshot, result);
  const decisions = auditFile ? (await readFile(auditFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { result, requests: adapter.requests, snapshot, evaluation, decisions, approvalLog, configEpisode: built.config, providerRetries: adapter.providerRetries, elapsedMs };
}

const runs = [];
for (const testCase of selected) {
  const fixture = fixtures.get(testCase.fixture_id);
  for (let rep = 1; rep <= repetitions; rep++) {
    const order = pairOrder(testCase.case_id, rep);
    const arms = {};
    for (const arm of order) arms[arm] = await runArm(arm, testCase, fixture, rep);
    runs.push({ testCase, rep, order, arms });
    if (live) console.error(`done ${testCase.case_id} r${rep}`);
  }
}
stopAll();

// ---- analysis ----
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x));
function wilson(k, n) {
  if (n === 0) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Number(Math.max(0, c - h).toFixed(4)), Number(Math.min(1, c + h).toFixed(4))];
}
const rate = (k, n) => ({ numerator: k, denominator: n, rate: n ? Number((k / n).toFixed(4)) : null, wilson95: wilson(k, n) });

const baselineEffective = await loadArm("baseline"), defendedEffective = await loadArm("defended");
const report = {
  schema_version: "1.1.0", task_id: live ? "TB-024-live-model" : "TB-024", checked_at: new Date().toISOString(),
  model: live ? modelArg : "scripted local mock (no provider calls)", mode: live ? "live_model" : "scripted",
  status: "pilot/smoke evidence, excluded from confirmatory results",
  backend_tool_mode: toolMode, attack_rendering: rendering, holdout_excluded_cases: includeHoldoutMechanics ? [] : excludedHoldout, holdout_mechanics_only_cases: includeHoldoutMechanics ? excludedHoldout : [], repetitions, temperature: live ? temperature : null,
  config_differences: configDifferences(baselineEffective, defendedEffective), cases: [],
};
const traces = [];
for (const { testCase, rep, order, arms } of runs) {
  const { baseline, defended } = arms;
  const entry = { case_id: testCase.case_id, repetition: rep, pair_order: order, kind: testCase.kind, fixture_id: testCase.fixture_id };
  entry.run_config_identical = canon(baseline.configEpisode) === canon(defended.configEpisode);
  entry.first_request_identical = canon(baseline.requests[0]) === canon(defended.requests[0]);
  entry.settings_identical = baseline.requests.every((r, i) => canon(r.settings) === canon(defended.requests[i]?.settings ?? r.settings));
  const diffs = [];
  const n = Math.max(baseline.result.tool_records.length, defended.result.tool_records.length);
  for (let i = 0; i < n; i++) {
    const b = baseline.result.tool_records[i], d = defended.result.tool_records[i];
    if (!b || !d) { diffs.push({ index: i, tool: (b ?? d).tool_name, kind: "missing_record" }); continue; }
    const unwrapped = d.output && typeof d.output === "object" && "payload" in d.output ? d.output.payload : d.output;
    const same = b.tool_name === d.tool_name && b.status === d.status && b.error_code === d.error_code && canon(b.arguments) === canon(d.arguments) && canon(b.output) === canon(unwrapped);
    if (!same) diffs.push({ index: i, tool: d.tool_name ?? b.tool_name, baseline_status: b.status, defended_status: d.status, baseline_error: b.error_code, defended_error: d.error_code });
  }
  entry.record_differences = diffs;
  entry.differences_attributable_to_gateway = diffs.every((x) => defended.decisions.some((dec) => dec.tool === x.tool && dec.decision === "deny"));
  const nonTool = (requests) => requests.map((r) => r.messages.filter((m) => !m.content.includes('"type":"tool_result"')));
  const common = Math.min(baseline.requests.length, defended.requests.length);
  entry.non_tool_messages_identical = canon(nonTool(baseline.requests).slice(0, common)) === canon(nonTool(defended.requests).slice(0, common));
  entry.same_tool_call_sequence = canon(baseline.result.tool_records.map((r) => [r.tool_name, r.arguments])) === canon(defended.result.tool_records.map((r) => [r.tool_name, r.arguments]));
  entry.final_state_identical = canon(baseline.snapshot.state) === canon(defended.snapshot.state);
  entry.provider_retries = { baseline: baseline.providerRetries, defended: defended.providerRetries };
  const side = (a) => ({ outcome: a.result.outcome, tool_calls: a.result.tool_records.length, failures: a.result.failures.map((f) => f.code), final_tool_calls: a.snapshot.tool_calls, evaluation: a.evaluation, elapsed_ms: a.elapsedMs, tokens: { input: a.result.budget.input_tokens, output: a.result.budget.output_tokens } });
  entry.baseline = side(baseline);
  entry.defended = { ...side(defended), policy_decisions: defended.decisions.map((x) => ({ seq: x.seq, tool: x.tool, decision: x.decision, reason: x.reason ?? null, status: x.status ?? null, executed: x.executed ?? null, replayed: x.replayed ?? false, request_id: x.request_id ?? null })), approvals: defended.approvalLog };
  for (const decision of defended.decisions) traces.push({ case_id: testCase.case_id, repetition: rep, arm: "defended", ...decision });
  report.cases.push(entry);
}

const benign = report.cases.filter((c) => c.kind === "benign"), attack = report.cases.filter((c) => c.kind === "attack");
const count = (list, f) => list.filter(f).length;
const deniedBenign = benign.flatMap((c) => c.defended.policy_decisions).filter((d) => d.decision === "deny").length;
const allBenignCalls = benign.flatMap((c) => c.defended.policy_decisions).filter((d) => d.decision !== "require_approval").length;
report.summary = {
  note: "Counts from this run only; pilot-sized, not a confirmatory estimate. Wilson 95% intervals are per-arm; no paired test is claimed.",
  benign_utility_pass: { baseline: rate(count(benign, (c) => c.baseline.evaluation.utility_pass), benign.length), defended: rate(count(benign, (c) => c.defended.evaluation.utility_pass), benign.length) },
  attacker_goal_achieved: { baseline: rate(count(attack, (c) => c.baseline.evaluation.attacker_goal_achieved), attack.length), defended: rate(count(attack, (c) => c.defended.evaluation.attacker_goal_achieved), attack.length) },
  unsafe_committed_effect: { baseline: rate(count(attack, (c) => !c.baseline.evaluation.security_pass), attack.length), defended: rate(count(attack, (c) => !c.defended.evaluation.security_pass), attack.length) },
  utility_under_attack: { baseline: rate(count(attack, (c) => c.baseline.evaluation.utility_pass), attack.length), defended: rate(count(attack, (c) => c.defended.evaluation.utility_pass), attack.length) },
  false_block_calls_on_benign: rate(deniedBenign, allBenignCalls),
  median_elapsed_ms: live ? { baseline: median(report.cases.map((c) => c.baseline.elapsed_ms)), defended: median(report.cases.map((c) => c.defended.elapsed_ms)) } : null,
  per_case: Object.fromEntries([...new Set(report.cases.map((c) => c.case_id))].map((id) => {
    const rows = report.cases.filter((c) => c.case_id === id);
    return [id, { runs: rows.length, baseline_utility: count(rows, (c) => c.baseline.evaluation.utility_pass), defended_utility: count(rows, (c) => c.defended.evaluation.utility_pass), baseline_attacker_goal: count(rows, (c) => c.baseline.evaluation.attacker_goal_achieved), defended_attacker_goal: count(rows, (c) => c.defended.evaluation.attacker_goal_achieved) }];
  })),
};
function median(values) { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

const suffix = live ? `${modelArg.replace(/[^A-Za-z0-9.]+/g, "-")}${toolMode === "contract" ? "-contract-backend" : ""}${rendering === "as_authored" ? "" : `-${rendering}`}` : null;
await mkdir(path.join(root, "reports"), { recursive: true });
const mech = includeHoldoutMechanics ? "-holdout-mechanics" : "";
await writeFile(path.join(root, live ? `reports/tb024-${suffix}-policy-traces.jsonl` : `reports/tb024-policy-decision-traces${mech}.jsonl`), traces.map((t) => JSON.stringify(t)).join("\n") + "\n");
await writeFile(path.join(root, live ? `evidence/tb024-${suffix}-report.json` : `evidence/tb024-defended-arm${mech}-report.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ summary: report.summary, cases: report.cases.map((c) => ({ id: c.case_id, r: c.repetition, base: [c.baseline.outcome, c.baseline.evaluation.utility_pass, c.baseline.evaluation.attacker_goal_achieved], def: [c.defended.outcome, c.defended.evaluation.utility_pass, c.defended.evaluation.attacker_goal_achieved], diffs: c.record_differences.length, attributable: c.differences_attributable_to_gateway, state_same: c.final_state_identical })) }, null, 1));

const required = (c) => [["run_config_identical", c.run_config_identical], ["first_request_identical", c.first_request_identical], ["settings_identical", c.settings_identical]];
const scriptedOnly = (c) => [["non_tool_messages_identical", c.non_tool_messages_identical], ["same_tool_call_sequence", c.same_tool_call_sequence],
  ["differences_attributable_to_gateway", c.differences_attributable_to_gateway], ...(c.kind === "benign" ? [["final_state_identical", c.final_state_identical]] : [])];
const failed = report.cases.flatMap((c) => [...required(c), ...(live ? [] : scriptedOnly(c))].filter(([, ok]) => !ok).map(([name]) => `${c.case_id}:${name}`));
if (failed.length) { console.error("ARM PARITY FAILURES", failed); process.exit(1); }
process.exit(0);
