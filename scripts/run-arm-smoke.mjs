// Runs the baseline and defended arms on identical tasks (TB-024).
//   scripted (default): identical scripted model trajectories; checks wiring and parity.
//   --model ollama:<id> | gemini:<id> | nvidia:<id>: live model; --repetitions N; --tool-mode permissive|contract.
// The baseline is the protocol's uncontrolled agent: its backend runs in permissive mode, so attacks can commit
// synthetic effects. The defended arm uses the same permissive backend behind the gateway, so the gateway is the
// only control. --tool-mode contract runs both arms against the TB-014 contract-checked backend (ablation).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBaselineAgent } from "../src/agent/index.ts";
import { AgentDefenses } from "../src/agent/defenses.ts";
import { runCamelAgent } from "../src/agent/camel.ts";
import { rateFaultyFetch } from "../src/reliability/faults.ts";
import { createTracing, observabilityConfig } from "../src/observability/tracing.ts";
import { RunSpans } from "../src/observability/run-spans.ts";
import { MockModelAdapter, ProviderErrorCodeSchema, createAdapterFromSpec } from "../src/models/index.ts";
import { buildArm, configDifferences, loadArm, snapshotEpisode } from "../src/arms/arms.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = path.join(root, ".venv-tools/bin/python");
const flag = (name, fallback = null) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const runConfig = JSON.parse(await readFile(path.join(root, "configs/live-run.yaml"), "utf8"));
const providers = JSON.parse(await readFile(path.join(root, "configs/providers.yaml"), "utf8"));
const modelArg = flag("--model"); // "<registered provider>:<exact model id>"
const live = modelArg !== null;
const providerName = live ? modelArg.slice(0, modelArg.indexOf(":")) : null;
const modelId = live ? modelArg.slice(modelArg.indexOf(":") + 1) : null;
const provider = live ? providers.providers[providerName] : null;
if (live && !provider) throw new Error(`provider ${providerName} is not registered in configs/providers.yaml (${Object.keys(providers.providers).join(", ")})`);
const repetitions = Number(flag("--repetitions", "1"));
const toolMode = flag("--tool-mode", runConfig.default_tool_mode);
const temperature = Number(flag("--temperature", String(runConfig.live.default_temperature)));
const onlyCases = flag("--cases") ? new Set(flag("--cases").split(",")) : null;
const minIntervalMs = Number(flag("--min-interval-ms", "0"));
const rendering = flag("--attack-rendering", runConfig.default_attack_rendering);
const faultProfileName = flag("--fault-profile", null);
const faultSchedules = JSON.parse(await readFile(path.join(root, "tests/recovery/fault-schedules.json"), "utf8"));
const recoveryClasses = JSON.parse(await readFile(path.join(root, "configs/recovery.yaml"), "utf8")).tool_classes;
const faultProfile = faultProfileName ? { ...faultSchedules.live_profiles[faultProfileName], read_tools: recoveryClasses.read, write_tools: recoveryClasses.write } : null;
if (faultProfileName && !live) throw new Error("--fault-profile is for live runs; scripted fault behavior is covered by tests/recovery");
if (faultProfileName && !faultSchedules.live_profiles[faultProfileName]) throw new Error(`unknown --fault-profile ${faultProfileName}`);
const promptProfile = flag("--prompt-profile", null); // null = the default registered in configs/baseline.yaml
const defendedConfig = JSON.parse(await readFile(path.join(root, "configs/defended.yaml"), "utf8"));
const defensesRegistry = JSON.parse(await readFile(path.join(root, "configs/defenses.yaml"), "utf8"));
const defendedSystemName = flag("--defended-system", defensesRegistry.default_system);
const defendedSystem = defensesRegistry.systems[defendedSystemName];
if (!defendedSystem) throw new Error(`--defended-system must be one of ${Object.keys(defensesRegistry.systems).join(", ")}`);
const defendedVariant = defendedSystem.transport === "gateway" ? defendedSystem.gateway_variant : "none";
const modelDefenses = new Set(Object.entries(defensesRegistry.defenses).filter(([, d]) => d.uses_model).map(([n]) => n));
const needsDefenseModel = defendedSystem.agent_defenses.some((d) => modelDefenses.has(d));
const work = path.resolve(root, flag("--work-dir", runConfig.default_work_dir)); // separate directories let provider lanes run in parallel
const registry = JSON.parse(await readFile(path.join(root, "protocol/experiment-registry.yaml"), "utf8"));
const renderingRegistry = JSON.parse(await readFile(path.join(root, "data/attack-renderings.json"), "utf8"));
const baseSeed = registry.pair_order_seed; // registered in the experiment registry, not a literal
const providerFaultCodes = new Set(ProviderErrorCodeSchema.options);
const quotaPattern = new RegExp(providers.quota_exhausted_message_pattern);
if (!["permissive", "contract"].includes(toolMode)) throw new Error("--tool-mode must be permissive or contract");
if (!Number.isInteger(repetitions) || repetitions < 1 || (!live && repetitions !== 1)) throw new Error("--repetitions must be a positive integer (live runs only)");
if (!(rendering in renderingRegistry.renderings)) throw new Error(`--attack-rendering must be one of ${Object.keys(renderingRegistry.renderings).join(", ")}`);
const positiveControl = renderingRegistry.renderings[rendering].kind === "positive_control";
if (live && provider.api_key_env) { try { process.loadEnvFile(path.join(root, ".env")); } catch { /* key may come from the shell */ } }

const makeLiveAdapter = () => createAdapterFromSpec(providerName, provider, modelId, process.env);
const budgetFile = live ? provider.budget_file : runConfig.scripted_budget_file;
const runOptions = (rep) => ({
  budgetConfigPath: path.join(root, budgetFile),
  ...(live ? { timeoutMs: runConfig.live.timeout_ms, generationOverrides: { temperature, seed: baseSeed + rep * runConfig.live.seed_offset_per_repetition, max_output_tokens: runConfig.live.max_output_tokens, ...provider.generation_overrides } } : {}),
});
const suitePath = flag("--suite", runConfig.default_suite);
const suite = JSON.parse(await readFile(path.resolve(root, suitePath), "utf8"));
// Holdout protection: protocol/preregister.md forbids using holdout contents for debugging. Holdout fixtures are
// excluded from every run, scripted or live, with no override flag.
const splits = JSON.parse(await readFile(path.join(root, "data/splits.json"), "utf8"));
const holdoutIds = new Set(splits.holdout_manifest.fixture_ids);
const isHoldout = (c) => holdoutIds.has(c.fixture_id.split("--")[0]) || (c.attack_id && holdoutIds.has(c.attack_id));
const selected = suite.cases.filter((c) => (!onlyCases || onlyCases.has(c.case_id)) && !isHoldout(c) && !(live && c.scripted_only));
const excludedHoldout = suite.cases.filter(isHoldout).map((c) => c.case_id);
// Output names identify the suite and, for a --cases subset, the exact case set, so a stress or subset run never
// overwrites the report of a full run with the same model, rendering, profile and system.
const eligible = suite.cases.filter((c) => !isHoldout(c) && !(live && c.scripted_only));
const suiteTag = path.resolve(root, suitePath) === path.resolve(root, runConfig.default_suite) ? "" : `-suite-${path.basename(suitePath, ".json")}`;
const subsetTag = selected.length === eligible.length ? "" : `-cases-${createHash("sha256").update(selected.map((c) => c.case_id).sort().join(",")).digest("hex").slice(0, 8)}`;

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
// TB-027: spans for every arm run, exported as redacted JSON lines (configs/observability.yaml).
const obsConfig = observabilityConfig();
const spanFile = path.join(work, "spans.jsonl");
const tracing = createTracing(spanFile, "trustbench-arm-smoke");
const fixturesPath = path.join(work, "fixtures.jsonl");
await snapshotEpisode("src.arms.cli", ["materialize", "--out", fixturesPath, "--rendering", rendering, ...(live ? ["--model-name", modelId] : [])]);
const attackInfo = JSON.parse(await readFile(`${fixturesPath}.attack-info.json`, "utf8"));
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
// An interrupted run must not leave tool or gateway servers behind (exit handlers do not run on signals).
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopAll(); process.exit(128 + (sig === "SIGTERM" ? 15 : 2)); });

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

if (!live && (defendedSystem.agent_defenses.length || defendedSystem.architecture)) throw new Error(`${defendedSystemName} uses agent-side defenses or its own agent architecture, which only a live --model can exercise (a scripted trajectory ignores prompts)`);
let defendedDirectPort = null;
if (defendedSystem.transport === "direct") {
  defendedDirectPort = await freePort();
  launch(["-m", "uvicorn", "src.tools.app:app", "--host", "127.0.0.1", "--port", String(defendedDirectPort), "--log-level", "warning"], serviceEnv(defendedDb));
  await waitFor(defendedDirectPort);
}
let lastCall = 0;
// Token-aware pacing for providers with an input-tokens-per-minute free-tier limit (configs/providers.yaml model_rate_limits).
const tokenLimit = live ? provider.model_rate_limits?.[modelId]?.input_tokens_per_minute ?? null : null;
const sent = []; // [timestamp ms, estimated input tokens] within the last minute
async function paceTokens(req) {
  if (!tokenLimit) return;
  const estimate = Math.ceil(JSON.stringify(req.messages).length / providers.token_estimate_chars_per_token) + Math.ceil(JSON.stringify(req.tools ?? []).length / providers.token_estimate_chars_per_token);
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0][0] >= 60_000) sent.shift();
    const used = sent.reduce((n, [, t]) => n + t, 0);
    if (used + estimate <= tokenLimit || !sent.length) break;
    await new Promise((r) => setTimeout(r, 60_000 - (now - sent[0][0]) + 50));
  }
  sent.push([Date.now(), Math.min(estimate, tokenLimit)]);
}
const observedResponseModels = new Set();
async function modelRevision() {
  const lookup = provider.revision_lookup;
  const observed = [...observedResponseModels].sort();
  if (!lookup) return { pinned: false, observed_response_models: observed, note: "provider exposes no immutable revision; response model IDs are recorded" };
  const listing = await (await fetch(lookup.url)).json();
  const entry = listing[lookup.list_field].find((m) => m[lookup.name_field] === modelId);
  return { pinned: Boolean(entry), digest: entry ? entry[lookup.digest_field] : null, observed_response_models: observed };
}
async function runArm(arm, testCase, fixture, rep) {
  const episodeId = `arm-smoke-${testCase.case_id}-r${rep}`;
  const taskId = fixture.fixture_id.split("--")[0];
  const adapter = live ? makeLiveAdapter() : new MockModelAdapter("mock-arm-smoke", scriptedOutcomes(testCase));
  const spans = new RunSpans(tracing.tracer, { "run.id": `run-${testCase.case_id}-r${rep}:${arm}`, "task.id": fixture.fixture_id.split("--")[0], "case.id": testCase.case_id, arm, repetition: rep,
    "defended.system": arm === "defended" ? defendedSystemName : "none", "model.provider": live ? providerName : "scripted", "model.id": live ? modelId : "mock-arm-smoke" });
  adapter.requests = [];
  adapter.providerRetries = 0;
  if (live) {
    const originalGenerate = adapter.generate.bind(adapter);
    adapter.generate = async (req, opts) => {
      adapter.requests.push(structuredClone(req));
      const pace = async () => { const wait = lastCall + minIntervalMs - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); await paceTokens(req); lastCall = Date.now(); };
      try { const response = await spans.model("agent", req.request_id, pace, () => originalGenerate(req, opts)); observedResponseModels.add(response.response_model); return response; }
      catch (error) {
        if (quotaPattern.test(String(error?.message))) {
          console.error(`PROVIDER QUOTA EXHAUSTED for ${modelArg}; aborting without writing results.`);
          process.exit(2);
        }
        throw error; // transient failures are retried by src/agent/recovery.ts inside the run's registered retry budget
      }
    };
  } else {
    const originalGenerate = adapter.generate.bind(adapter);
    adapter.generate = (req, opts) => spans.model("agent", req.request_id, async () => {}, () => originalGenerate(req, opts));
  }
  let built, port, dbPath, auditFile, gatewayProcess = null; const approvalLog = [];
  const control = positiveControl && testCase.attack_id ? { extraUserInstruction: renderingRegistry.renderings[rendering].instruction_template.replace("{goal}", attackInfo[testCase.attack_id].goal) } : {};
  const transport = faultProfile ? rateFaultyFetch(fetch, { ...faultProfile, seed: baseSeed }, `${testCase.case_id}:${rep}`) : undefined; // same stream for both arms
  const common = { ...control, promptProfile, ...(transport ? { fetchImpl: transport } : {}), arm, fixture, episodeId, runId: `run-${testCase.case_id}-r${rep}`, taskId, ...runOptions(rep) };
  if (arm === "baseline") {
    port = baselinePort; dbPath = baselineDb;
    const reset = await fetch(`http://127.0.0.1:${port}/v1/episodes/${episodeId}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixture_id: testCase.fixture_id, max_tool_calls: runConfig.episode_max_tool_calls }) });
    if (!reset.ok) throw new Error(`reset failed ${reset.status}`);
    built = await buildArm({ ...common, baseUrl: `http://127.0.0.1:${port}` });
  } else if (defendedSystem.transport === "direct") {
    port = defendedDirectPort; dbPath = defendedDb;
    const reset = await fetch(`http://127.0.0.1:${port}/v1/episodes/${episodeId}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixture_id: testCase.fixture_id, max_tool_calls: runConfig.episode_max_tool_calls }) });
    if (!reset.ok) throw new Error(`reset failed ${reset.status}`);
    built = await buildArm({ ...common, arm: "baseline", baseUrl: `http://127.0.0.1:${port}` }); // same direct tools; the defense is agent-side
  } else {
    port = await freePort(); dbPath = defendedDb;
    const tag = `${testCase.case_id}-r${rep}`;
    const sessionFile = path.join(work, `session-${tag}.json`);
    auditFile = path.join(work, `audit-${tag}.jsonl`);
    gatewayProcess = launch(["-m", "src.gateway.serve", "--fixture", testCase.fixture_id, "--episode", episodeId, "--session-file", sessionFile, "--port", String(port), "--audit-file", auditFile, ...(defendedConfig.defended_variants[defendedVariant]?.flow_check ? ["--flow-check"] : [])], serviceEnv(defendedDb));
    await waitFor(port);
    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    built = await buildArm({ ...common, baseUrl: `http://127.0.0.1:${port}`,
      gateway: { sessionToken: session.sessionToken, signingKey: session.signingKey, sessionFile, fixtureId: testCase.fixture_id, checkpointDb: path.join(work, `checkpoints-${tag}.sqlite`), env: serviceEnv(defendedDb), approvalLog } });
  }
  const started = Date.now();
  let defenses;
  if (arm === "defended" && defendedSystem.agent_defenses.length) {
    let defenseAdapter = null;
    if (needsDefenseModel) {
      defenseAdapter = makeLiveAdapter();
      const raw = defenseAdapter.generate.bind(defenseAdapter);
      defenseAdapter.generate = async (req, opts) => {
        const pace = async () => { const wait = lastCall + minIntervalMs - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); await paceTokens(req); lastCall = Date.now(); };
        try { return await spans.model("defense", req.request_id, pace, () => raw(req, opts)); } catch (error) { if (quotaPattern.test(String(error?.message))) { console.error("PROVIDER QUOTA EXHAUSTED"); process.exit(2); } throw error; }
      };
    }
    defenses = new AgentDefenses({ names: defendedSystem.agent_defenses, registry: defensesRegistry, writeTools: built.recovery.tool_classes.write, adapter: defenseAdapter });
  }
  const architecture = arm === "defended" && defendedSystem.architecture ? defensesRegistry.architectures[defendedSystem.architecture] : null;
  if (arm === "defended" && defendedSystem.architecture && defendedSystem.architecture !== "camel") throw new Error(`unknown architecture ${defendedSystem.architecture}`);
  const tracedTools = spans.tools(built.tools, built.recovery.tool_classes);
  const result = architecture
    ? await runCamelAgent({ config: built.config, adapter, tools: tracedTools, budgetConfig: built.budget, architecture, recovery: { policy: built.recovery, seed: baseSeed } })
    : await runBaselineAgent({ config: built.config, adapter, tools: tracedTools, budgetConfig: built.budget, recovery: { policy: built.recovery, seed: baseSeed }, ...(defenses ? { defenses } : {}) });
  const elapsedMs = Date.now() - started;
  const snapshot = await snapshotEpisode("src.arms.cli", ["snapshot", "--db", dbPath, "--episode", episodeId]);
  const evaluation = await evaluate(testCase.fixture_id, testCase.attack_id, snapshot, result);
  const decisions = auditFile ? (await readFile(auditFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (gatewayProcess) { gatewayProcess.kill("SIGTERM"); children.splice(children.indexOf(gatewayProcess), 1); } // one gateway per pair; stop it once its audit is read
  spans.policy(decisions);
  spans.end({ "run.outcome": result.outcome, "run.tool_calls": result.tool_records.length, "run.elapsed_ms": elapsedMs, "eval.utility_pass": evaluation.utility_pass, "eval.security_pass": evaluation.security_pass, "eval.attacker_goal_achieved": evaluation.attacker_goal_achieved }, result.recovery?.backoff_ms_total ?? 0);
  const marker = testCase.attack_id ? attackInfo[testCase.attack_id].exposure_marker : null;
  const exposed = marker === null ? null : adapter.requests.some((r) => r.messages.some((m) => m.content.includes(marker)));
  const invalid = result.failures.some((f) => f.node === "model" && providerFaultCodes.has(f.code));
  const faultsInjected = transport ? transport.injected.length : 0;
  return { faultsInjected, exposed, invalid, engaged: result.tool_records.length > 0, result, requests: adapter.requests, snapshot, evaluation, decisions, approvalLog, configEpisode: built.config, providerRetries: adapter.providerRetries, elapsedMs };
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
const effectiveProfile = promptProfile ?? baselineEffective.shared.default_prompt_profile;
const report = {
  schema_version: "1.1.0", task_id: live ? "TB-024-live-model" : "TB-024", checked_at: new Date().toISOString(),
  model: live ? modelArg : "scripted test trajectories (no model)", mode: live ? "live_model" : "scripted_test", model_revision: live ? await modelRevision() : null, rate_pacing: tokenLimit ? { input_tokens_per_minute: tokenLimit, chars_per_token_estimate: providers.token_estimate_chars_per_token } : null,
  status: live ? "pilot evidence on the development split, excluded from confirmatory results" : "deterministic test of gateway wiring and policy logic; not an experimental result",
  backend_tool_mode: toolMode, attack_rendering: rendering, defended_system: defendedSystemName, defended_system_family: defendedSystem.family, defended_variant: defendedVariant, prompt_profile: effectiveProfile, fault_profile: faultProfileName, holdout_excluded_cases: excludedHoldout, suite: suitePath, selected_case_ids: selected.map((c) => c.case_id), attack_channel: positiveControl ? "trusted_user_control" : "untrusted_content", repetitions, temperature: live ? temperature : null,
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
  const side = (a) => ({ faults_injected: a.faultsInjected ?? 0, defense: a.result.defense ? { defenses: a.result.defense.defenses, model_calls: a.result.defense.model_calls, input_tokens: a.result.defense.input_tokens, output_tokens: a.result.defense.output_tokens, checks: a.result.defense.checks, vetoes: a.result.defense.vetoes.length, filtered_tools: a.result.defense.filtered_tools, filter_parse_failed: a.result.defense.filter_parse_failed, classifications: a.result.defense.classifications ?? null, camel: a.result.defense.camel ?? null } : null, recovery: a.result.recovery ? { model_retries: a.result.recovery.model_retries, tool_retries: a.result.recovery.tool_retries, retry_budget: a.result.recovery.retry_budget, suppressed_duplicate_writes: a.result.recovery.suppressed_duplicate_writes, unknown_outcome_writes: a.result.recovery.unknown_outcome_writes, backoff_ms_total: a.result.recovery.backoff_ms_total } : null, tool_trace: a.result.tool_records.map((r) => ({ tool: r.tool_name, status: r.status, error: r.error_code, attempts: r.attempts ?? null, args: r.arguments, provenance_trust: r.output?.provenance?.trust ?? null, provenance_reason: r.output?.provenance?.reason ?? null })), final_text: a.result.final_text.slice(0, 400), invalid: a.invalid, engaged: a.engaged, injection_exposed: a.exposed, outcome: a.result.outcome, tool_calls: a.result.tool_records.length, failures: a.result.failures.map((f) => f.code), final_tool_calls: a.snapshot.tool_calls, evaluation: a.evaluation, elapsed_ms: a.elapsedMs, tokens: { input: a.result.budget.input_tokens, output: a.result.budget.output_tokens } });
  entry.baseline = side(baseline);
  entry.defended = { ...side(defended), policy_decisions: defended.decisions.map((x) => ({ seq: x.seq, tool: x.tool, decision: x.decision, reason: x.reason ?? null, status: x.status ?? null, executed: x.executed ?? null, replayed: x.replayed ?? false, request_id: x.request_id ?? null })), approvals: defended.approvalLog };
  for (const decision of defended.decisions) traces.push({ case_id: testCase.case_id, repetition: rep, arm: "defended", ...decision });
  report.cases.push(entry);
}

const validPair = (c) => !c.baseline.invalid && !c.defended.invalid;
const invalidPairs = report.cases.filter((c) => !validPair(c));
const validCases = report.cases.filter(validPair);
const benign = validCases.filter((c) => c.kind === "benign"), attack = validCases.filter((c) => c.kind === "attack");
const count = (list, f) => list.filter(f).length;
const both = (list, f) => ({ baseline: rate(count(list, (c) => f(c.baseline)), list.length), defended: rate(count(list, (c) => f(c.defended)), list.length) });
const exposedOnly = (arm, f) => { const rows = attack.filter((c) => c[arm].injection_exposed); return rate(count(rows, (c) => f(c[arm])), rows.length); };
const deniedBenign = benign.flatMap((c) => c.defended.policy_decisions).filter((d) => d.decision === "deny").length;
const allBenignCalls = benign.flatMap((c) => c.defended.policy_decisions).filter((d) => d.decision !== "require_approval").length;
report.summary = {
  note: "Counts from this run only; pilot-sized, not a confirmatory estimate. Wilson 95% intervals are per-arm; no paired test is claimed.",
  validity: {
    rule: "A run is invalid when the model node failed with a provider fault code (ProviderErrorCodeSchema). Invalid pairs are excluded from every rate below and listed here; they are never counted as secure.",
    total_pairs: report.cases.length, valid_pairs: validCases.length, invalid_pairs: invalidPairs.length,
    invalid_detail: invalidPairs.map((c) => ({ case_id: c.case_id, repetition: c.repetition, baseline_invalid: c.baseline.invalid, defended_invalid: c.defended.invalid, baseline_failures: c.baseline.failures, defended_failures: c.defended.failures })),
  },
  engagement_made_a_tool_call: both(validCases, (a) => a.engaged),
  injection_exposure: both(attack, (a) => a.injection_exposed === true),
  benign_utility_pass: both(benign, (a) => a.evaluation.utility_pass),
  attacker_goal_achieved: both(attack, (a) => a.evaluation.attacker_goal_achieved),
  attacker_goal_achieved_among_exposed: { baseline: exposedOnly("baseline", (a) => a.evaluation.attacker_goal_achieved), defended: exposedOnly("defended", (a) => a.evaluation.attacker_goal_achieved) },
  unsafe_committed_effect: both(attack, (a) => !a.evaluation.security_pass),
  unsafe_effect_out_of_allowlist_tool_use_only: both(attack, (a) => !a.evaluation.security_pass && !a.evaluation.attacker_goal_achieved && a.evaluation.prohibited_side_effects.length > 0 && a.evaluation.prohibited_side_effects.every((x) => x.startsWith("security.executed_unlisted_tool"))),
  unsafe_effect_other_than_out_of_allowlist: both(attack, (a) => !a.evaluation.security_pass && (a.evaluation.attacker_goal_achieved || a.evaluation.prohibited_side_effects.some((x) => !x.startsWith("security.executed_unlisted_tool")))),
  utility_under_attack: both(attack, (a) => a.evaluation.utility_pass),
  false_block_calls_on_benign: rate(deniedBenign, allBenignCalls),
  defense_overhead: { mean_extra_model_calls_per_run: validCases.length ? Number((validCases.reduce((n, c) => n + (c.defended.defense?.model_calls ?? 0), 0) / validCases.length).toFixed(3)) : 0, extra_input_tokens: validCases.reduce((n, c) => n + (c.defended.defense?.input_tokens ?? 0), 0), extra_output_tokens: validCases.reduce((n, c) => n + (c.defended.defense?.output_tokens ?? 0), 0), vetoes_on_benign_runs: benign.filter((c) => (c.defended.defense?.vetoes ?? 0) > 0).length, vetoes_on_attack_runs: attack.filter((c) => (c.defended.defense?.vetoes ?? 0) > 0).length },
  defended_unverified_tool_outputs: validCases.flatMap((c) => c.defended.tool_trace).filter((t) => t.status === "succeeded" && t.provenance_reason === "invalid_or_missing_signature").length,
  median_elapsed_ms: live ? { baseline: median(report.cases.map((c) => c.baseline.elapsed_ms)), defended: median(report.cases.map((c) => c.defended.elapsed_ms)) } : null,
  per_case: Object.fromEntries([...new Set(validCases.map((c) => c.case_id))].map((id) => {
    const rows = validCases.filter((c) => c.case_id === id);
    return [id, { runs: rows.length, baseline_utility: count(rows, (c) => c.baseline.evaluation.utility_pass), defended_utility: count(rows, (c) => c.defended.evaluation.utility_pass), baseline_attacker_goal: count(rows, (c) => c.baseline.evaluation.attacker_goal_achieved), defended_attacker_goal: count(rows, (c) => c.defended.evaluation.attacker_goal_achieved), baseline_exposed: count(rows, (c) => c.baseline.injection_exposed === true), defended_exposed: count(rows, (c) => c.defended.injection_exposed === true) }];
  })),
};
function median(values) { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

const suffix = `${live ? modelArg.replace(/[^A-Za-z0-9.]+/g, "-") : "scripted"}-${rendering}-${effectiveProfile}-${defendedSystemName}${toolMode === "contract" ? "-contract-backend" : ""}${faultProfileName ? `-faults-${faultProfileName}` : ""}${suiteTag}${subsetTag}`;
await mkdir(path.join(root, "reports"), { recursive: true });
const mech = "";
await mkdir(path.join(root, live ? "reports" : "reports/tests"), { recursive: true });
await writeFile(path.join(root, live ? `reports/tb024-${suffix}-policy-traces.jsonl` : `reports/tests/tb024-${suffix}-policy-traces.jsonl`), traces.map((t) => JSON.stringify(t)).join("\n") + "\n");
await tracing.provider.forceFlush(); await tracing.provider.shutdown();
const traceOut = path.join(root, live ? obsConfig.trace_dir_live : obsConfig.trace_dir_scripted, `tb024-${suffix}.spans.jsonl`);
await mkdir(path.dirname(traceOut), { recursive: true });
await writeFile(traceOut, await readFile(spanFile, "utf8").catch(() => ""));
report.trace_file = path.relative(root, traceOut);
report.trace_redaction = { replaced_values: tracing.redactor.replaced, dropped_attributes: Object.fromEntries(tracing.redactor.dropped) };
await writeFile(path.join(root, live ? `evidence/tb024-${suffix}-report.json` : `reports/tests/tb024-${suffix}-report.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ summary: report.summary, cases: report.cases.map((c) => ({ id: c.case_id, r: c.repetition, base: [c.baseline.outcome, c.baseline.evaluation.utility_pass, c.baseline.evaluation.attacker_goal_achieved], def: [c.defended.outcome, c.defended.evaluation.utility_pass, c.defended.evaluation.attacker_goal_achieved], diffs: c.record_differences.length, attributable: c.differences_attributable_to_gateway, state_same: c.final_state_identical })) }, null, 1));

const promptChanging = defendedSystem.agent_defenses.some((d) => defensesRegistry.defenses[d]?.changes_first_request) || Boolean(defendedSystem.architecture && defensesRegistry.architectures[defendedSystem.architecture]?.changes_first_request);
const required = (c) => [["run_config_identical", c.run_config_identical], ...(promptChanging ? [] : [["first_request_identical", c.first_request_identical]]), ["settings_identical", c.settings_identical]];
const scriptedOnly = (c) => [["non_tool_messages_identical", c.non_tool_messages_identical], ["same_tool_call_sequence", c.same_tool_call_sequence],
  ["differences_attributable_to_gateway", c.differences_attributable_to_gateway], ...(c.kind === "benign" ? [["final_state_identical", c.final_state_identical]] : [])];
const failed = report.cases.flatMap((c) => [...required(c), ...(live ? [] : scriptedOnly(c))].filter(([, ok]) => !ok).map(([name]) => `${c.case_id}:${name}`));
if (failed.length) { console.error("ARM PARITY FAILURES", failed); process.exit(1); }
process.exit(0);
