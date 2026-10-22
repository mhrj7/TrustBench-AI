// Runs the baseline and defended arms on identical tasks (TB-024).
//   scripted (default): identical scripted model trajectories; checks wiring and parity.
//   --model ollama:<id> | gemini:<id> | nvidia:<id>: live model; --repetitions N; --tool-mode permissive|contract.
// The baseline is the protocol's uncontrolled agent: its backend runs in permissive mode, so attacks can commit
// synthetic effects. The defended arm uses the same permissive backend behind the gateway, so the gateway is the
// only control. --tool-mode contract runs both arms against the TB-014 contract-checked backend (ablation).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBaselineAgent } from "../src/agent/index.ts";
import { AgentDefenses } from "../src/agent/defenses.ts";
import { runCamelAgent } from "../src/agent/camel.ts";
import { faultyFetch, rateFaultyFetch } from "../src/reliability/faults.ts";
import { createTracing, observabilityConfig } from "../src/observability/tracing.ts";
import { RunSpans } from "../src/observability/run-spans.ts";
import { MockModelAdapter, ProviderErrorCodeSchema, createAdapterFromSpec } from "../src/models/index.ts";
import { buildArm, configDifferences, loadArm, snapshotEpisode } from "../src/arms/arms.ts";
import { externalAgents, runGooseAgent } from "../src/external/goose.ts";

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
// TB-028: a fixed task-seed schedule (src/evaluation/repeats.py) fixes the units, their seeds and the execution order.
const scheduleFile = flag("--schedule", null);
const schedule = scheduleFile ? JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", scheduleFile), "utf8")) : null;
const repetitions = schedule ? schedule.repetitions : Number(flag("--repetitions", "1"));
const toolMode = flag("--tool-mode", runConfig.default_tool_mode);
const temperature = Number(flag("--temperature", String(runConfig.live.default_temperature)));
const onlyCases = schedule ? new Set(schedule.entries.map((e) => e.case_id)) : flag("--cases") ? new Set(flag("--cases").split(",")) : null;
const minIntervalMs = Number(flag("--min-interval-ms", "0"));
const rendering = flag("--attack-rendering", runConfig.default_attack_rendering);
const faultProfileName = flag("--fault-profile", null);
const faultSchedules = JSON.parse(await readFile(path.join(root, "tests/recovery/fault-schedules.json"), "utf8"));
const recoveryClasses = JSON.parse(await readFile(path.join(root, "configs/recovery.yaml"), "utf8")).tool_classes;
const faultProfile = faultProfileName ? { ...faultSchedules.live_profiles[faultProfileName], read_tools: recoveryClasses.read, write_tools: recoveryClasses.write } : null;
if (faultProfileName && !live) throw new Error("--fault-profile is for live runs; scripted fault behavior is covered by tests/recovery");
if (faultProfileName && !faultSchedules.live_profiles[faultProfileName]) throw new Error(`unknown --fault-profile ${faultProfileName}`);
// TB-063: a fixed fault schedule (tests/recovery/fault-schedules.json rules), applied with fresh attempt counters to each
// arm run, so both arms of a pair meet the same faults; and a cancellation drill for an external agent.
const faultRulesName = flag("--fault-rules", null);
const approvalGatedTools = ["apply_record_update"];  // the tools src/arms/arms.ts routes through the approval workflow
const faultRules = faultRulesName ? faultSchedules.rules[faultRulesName] : null;
if (faultRulesName && !faultRules) throw new Error(`unknown --fault-rules ${faultRulesName}`);
if (faultRulesName && faultProfileName) throw new Error("--fault-rules and --fault-profile are exclusive");
const cancelAfterToolCalls = flag("--cancel-after-tool-calls", null) === null ? undefined : Number(flag("--cancel-after-tool-calls"));
const promptProfile = flag("--prompt-profile", null); // null = the default registered in configs/baseline.yaml
const defendedConfig = JSON.parse(await readFile(path.join(root, "configs/defended.yaml"), "utf8"));
const defensesRegistry = JSON.parse(await readFile(path.join(root, "configs/defenses.yaml"), "utf8"));
const defendedSystemName = flag("--defended-system", defensesRegistry.default_system);
// TB-036 (A-027): ablation-only systems and gateway variants come from configs/ablations.yaml, never overriding a name the
// frozen registries define.
const ablations = JSON.parse(await readFile(path.join(root, "configs/ablations.yaml"), "utf8"));
const isAblation = !(defendedSystemName in defensesRegistry.systems) && defendedSystemName in ablations.systems;
const defendedSystem = defensesRegistry.systems[defendedSystemName] ?? ablations.systems[defendedSystemName];
if (!defendedSystem) throw new Error(`--defended-system must be one of ${[...Object.keys(defensesRegistry.systems), ...Object.keys(ablations.systems)].join(", ")}`);
const defendedVariant = defendedSystem.transport === "gateway" ? defendedSystem.gateway_variant : "none";
const variantSpec = defendedConfig.defended_variants[defendedVariant] ?? ablations.gateway_variants[defendedVariant] ?? {};
const modelDefenses = new Set(Object.entries(defensesRegistry.defenses).filter(([, d]) => d.uses_model).map(([n]) => n));
const needsDefenseModel = defendedSystem.agent_defenses.some((d) => modelDefenses.has(d));
const work = path.resolve(root, flag("--work-dir", runConfig.default_work_dir)); // separate directories let provider lanes run in parallel
const registry = JSON.parse(await readFile(path.join(root, "protocol/experiment-registry.yaml"), "utf8"));
const renderingRegistry = JSON.parse(await readFile(path.join(root, "data/attack-renderings.json"), "utf8"));
const baseSeed = registry.pair_order_seed; // registered in the experiment registry, not a literal
const providerFaultCodes = new Set(ProviderErrorCodeSchema.options);
const quotaPattern = new RegExp(providers.quota_exhausted_message_pattern);
if (!["permissive", "contract"].includes(toolMode)) throw new Error("--tool-mode must be permissive or contract");
if (!Number.isInteger(repetitions) || repetitions < 1 || (!live && !schedule && repetitions !== 1)) throw new Error("--repetitions must be a positive integer (live runs only; scripted runs may repeat only through a --schedule)");
if (schedule && flag("--repetitions")) throw new Error("--schedule fixes the repetitions; do not pass --repetitions");
if (!(rendering in renderingRegistry.renderings)) throw new Error(`--attack-rendering must be one of ${Object.keys(renderingRegistry.renderings).join(", ")}`);
const positiveControl = renderingRegistry.renderings[rendering].kind === "positive_control";
// TRUSTBENCH_NO_DOTENV=1 (live-test service jobs): use only the key passed in the environment, never the project .env.
if (live && provider.api_key_env && process.env.TRUSTBENCH_NO_DOTENV !== "1") { try { process.loadEnvFile(path.join(root, ".env")); } catch { /* key may come from the shell */ } }

// TB-040 fault drills: TRUSTBENCH_DRILL_MODEL_BASE_URL points the live model at a loopback stub (refused, failing or hanging)
// to exercise an unavailable model. Loopback only, never in the confirmatory holdout mode, and recorded in the report.
const drillModelUrl = live ? process.env.TRUSTBENCH_DRILL_MODEL_BASE_URL ?? null : null;
if (drillModelUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(drillModelUrl).hostname)) throw new Error("TRUSTBENCH_DRILL_MODEL_BASE_URL must be a loopback URL");
const modelSpec = drillModelUrl ? { ...provider, base_url: drillModelUrl } : provider;
const makeLiveAdapter = () => createAdapterFromSpec(providerName, modelSpec, modelId, process.env);
const budgetFile = live ? provider.budget_file : runConfig.scripted_budget_file;
// TB-031 reliability sweep: --reliability <file> sets the step limit, the run timeout and the retry policy for both arms
// of every pair (identically), and is recorded in the report. Without it the registered values apply.
const reliabilityFile = flag("--reliability", null);
const reliability = reliabilityFile ? JSON.parse(await readFile(path.resolve(root, reliabilityFile), "utf8")) : null;
let recoveryOverridePath = null;
if (reliability?.retry) {
  const base = JSON.parse(await readFile(path.join(root, "configs/recovery.yaml"), "utf8"));
  base.retry = { ...base.retry, ...reliability.retry };
  recoveryOverridePath = path.join(root, ".tool-state", `recovery-${reliability.name}.json`);
  await mkdir(path.dirname(recoveryOverridePath), { recursive: true });
  await writeFile(recoveryOverridePath, JSON.stringify(base, null, 2));
}
const reportPrefix = flag("--report-prefix", "tb024");
// TB-057: --agent <name> runs a registered external agent (configs/external-agents.yaml) in BOTH arms through the
// integration contract; the arms still differ only in their tool path. Default: the built-in TrustBench agent.
const agentName = flag("--agent", "trustbench");
if (agentName !== "trustbench" && !(agentName in externalAgents.agents)) throw new Error(`--agent must be trustbench or one of ${Object.keys(externalAgents.agents).join(", ")}`);
const externalAgent = agentName === "trustbench" ? null : externalAgents.agents[agentName];
// One sandbox folder per run and pair: concurrent runs (live-service workers, tests) must never share or clear each
// other's folder. Both arms of a pair use the same folder name, so the paths goose reports are identical across arms.
const sandboxRunTag = createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 10);
// A longer run timeout only takes effect if the budget's elapsed-time limit grows with it, so the override raises both.
let budgetOverridePath = null;
if (reliability?.timeout_ms) {
  const b = JSON.parse(await readFile(path.join(root, budgetFile), "utf8"));
  b.limits = { ...b.limits, max_elapsed_ms: Math.max(b.limits.max_elapsed_ms, reliability.timeout_ms) };
  budgetOverridePath = path.join(root, ".tool-state", `budget-${reliability.name}.json`);
  await mkdir(path.dirname(budgetOverridePath), { recursive: true });
  await writeFile(budgetOverridePath, JSON.stringify(b, null, 2));
}
const runOptions = (rep) => ({
  budgetConfigPath: budgetOverridePath ?? path.join(root, budgetFile),
  ...(reliability?.max_steps ? { maxSteps: reliability.max_steps } : {}),
  ...(recoveryOverridePath ? { recoveryPolicyPath: recoveryOverridePath } : {}),
  ...(live ? { timeoutMs: reliability?.timeout_ms ?? runConfig.live.timeout_ms, generationOverrides: { temperature, seed: baseSeed + rep * runConfig.live.seed_offset_per_repetition, max_output_tokens: runConfig.live.max_output_tokens, ...provider.generation_overrides } } : {}),
});
const suitePath = flag("--suite", runConfig.default_suite);
const suite = JSON.parse(await readFile(path.resolve(root, suitePath), "utf8"));
// Holdout protection: protocol/preregister.md forbids using holdout contents for debugging. Holdout fixtures are
// excluded from every run, scripted or live, with no override flag.
const splits = JSON.parse(await readFile(path.join(root, "data/splits.json"), "utf8"));
// Every sealed set (the core holdout and holdout-2, A-026) is excluded from development runs.
const holdoutIds = new Set(["holdout_manifest", "holdout2_manifest"].filter((k) => splits[k]).flatMap((k) => splits[k].fixture_ids));
const isHoldout = (c) => holdoutIds.has(c.fixture_id.split("--")[0]) || (c.attack_id && holdoutIds.has(c.attack_id));
// TB-032 (A-025): --confirmatory-holdout is the one sanctioned holdout execution. It requires a PASS of the development
// release gate, the frozen configuration exactly (checked by scripts/verify-frozen.py and against
// configs/frozen/holdout-config.json), the registered holdout suite and a TB-028 schedule, and it refuses to run a rendering
// whose holdout run directory already exists, so no holdout unit runs twice.
const confirmatory = process.argv.includes("--confirmatory-holdout");
// Per-run output directory: the confirmatory holdout run directory, or --out-dir (live-test service jobs). When set, the
// report, policy traces, spans and pairs.jsonl go there instead of evidence/, reports/ and observability/.
let runOutDir = null;
if (confirmatory) {
  const hc = JSON.parse(await readFile(path.join(root, "configs/frozen/holdout-config.json"), "utf8"));
  const pace = JSON.parse(await readFile(path.join(root, "configs/frozen/live-matrix.yaml"), "utf8")).models[hc.model];
  const matrixRenderings = JSON.parse(await readFile(path.join(root, "configs/frozen/live-matrix.yaml"), "utf8")).renderings.map((r) => r.id);
  const gate = JSON.parse(await readFile(path.join(root, registry.holdout.confirmatory_gate_evidence), "utf8").catch(() => "{}"));
  const problems = [];
  if (gate.outcome !== "PASS") problems.push(`release gate outcome is ${gate.outcome ?? "missing"}, not PASS`);
  if (!live || modelArg !== hc.model) problems.push(`model must be ${hc.model}`);
  if (defendedSystemName !== hc.defended_system.system) problems.push(`defended system must be ${hc.defended_system.system}`);
  if (promptProfile !== hc.prompt_profile) problems.push(`prompt profile must be ${hc.prompt_profile}`);
  if (temperature !== pace.temperature || minIntervalMs !== pace.min_interval_ms) problems.push(`temperature and pacing must be ${pace.temperature} and ${pace.min_interval_ms} ms`);
  if (reliabilityFile !== hc.reliability.override_file) problems.push(`reliability must be ${hc.reliability.override_file}`);
  if (toolMode !== runConfig.default_tool_mode || faultProfileName || flag("--cases")) problems.push("no tool-mode, fault or case-subset overrides");
  // The core holdout (A-025) runs its suite in every live-matrix rendering; holdout-2 (A-026) runs the registered
  // (suite, rendering) pairs only.
  const h2 = registry.holdout2;
  const h2Suite = h2 ? Object.entries(h2.suites).find(([, p]) => p === suitePath)?.[0] : undefined;
  if (h2Suite) {
    if (!h2.runs.some((r) => r.suite === h2Suite && r.rendering === rendering)) problems.push(`holdout-2 suite ${h2Suite} is registered for ${h2.runs.filter((r) => r.suite === h2Suite).map((r) => r.rendering).join(", ")}`);
    const sealed2 = new Set(splits.holdout2_manifest.fixture_ids);
    if (!suite.cases.every((c) => sealed2.has(c.fixture_id.split("--")[0]) && (!c.attack_id || sealed2.has(c.attack_id)))) problems.push("holdout-2 suite holds a case outside holdout2_manifest");
  } else {
    if (!matrixRenderings.includes(rendering)) problems.push(`rendering must be one of ${matrixRenderings.join(", ")}`);
    if (suitePath !== registry.holdout.confirmatory_suite) problems.push(`suite must be ${registry.holdout.confirmatory_suite}${h2 ? ` or a holdout-2 suite (${Object.values(h2.suites).join(", ")})` : ""}`);
  }
  if (!schedule) problems.push("a TB-028 --schedule is required");
  if (schedule && schedule.repetitions !== registry.repetitions_per_pair) problems.push(`schedule repetitions must be ${registry.repetitions_per_pair}`);
  const frozen = await new Promise((resolve) => execFile(python, ["scripts/verify-frozen.py"], { cwd: root }, (error) => resolve(!error)));
  if (!frozen) problems.push("scripts/verify-frozen.py failed: live settings differ from configs/frozen");
  if (drillModelUrl) problems.push("a fault-drill model URL is set (TRUSTBENCH_DRILL_MODEL_BASE_URL)");
  if (problems.length) throw new Error(`--confirmatory-holdout refused:\n- ${problems.join("\n- ")}`);
  const runBase = h2Suite ? path.join(root, h2.confirmatory_run_dir, h2Suite) : path.join(root, registry.holdout.confirmatory_run_dir);
  await mkdir(runBase, { recursive: true });
  runOutDir = path.join(runBase, rendering);
  try { await mkdir(runOutDir); } catch { throw new Error(`--confirmatory-holdout refused: ${path.relative(root, runOutDir)} exists; each holdout unit runs once (A-025)`); }
  await writeFile(path.join(runOutDir, "started.json"), JSON.stringify({ started_at: new Date().toISOString(), argv: process.argv.slice(2), gate: registry.holdout.confirmatory_gate_evidence }, null, 1) + "\n");
}
if (!confirmatory && flag("--out-dir")) {
  runOutDir = path.resolve(root, flag("--out-dir"));
  await mkdir(runOutDir, { recursive: true });
}
const selected = confirmatory
  ? suite.cases.filter((c) => { if (!isHoldout(c)) throw new Error(`confirmatory suite case ${c.case_id} is not a holdout case`); return true; })
  : suite.cases.filter((c) => (!onlyCases || onlyCases.has(c.case_id)) && !isHoldout(c) && !(live && c.scripted_only));
const excludedHoldout = confirmatory ? [] : suite.cases.filter(isHoldout).map((c) => c.case_id);
// Output names identify the suite and, for a --cases subset, the exact case set, so a stress or subset run never
// overwrites the report of a full run with the same model, rendering, profile and system.
const eligible = confirmatory ? selected : suite.cases.filter((c) => !isHoldout(c) && !(live && c.scripted_only));
const suiteTag = path.resolve(root, suitePath) === path.resolve(root, runConfig.default_suite) ? "" : `-suite-${path.basename(suitePath, ".json")}`;
const subsetTag = selected.length === eligible.length ? "" : `-cases-${createHash("sha256").update(selected.map((c) => c.case_id).sort().join(",")).digest("hex").slice(0, 8)}`;

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
// TB-027: spans for every arm run, exported as redacted JSON lines (configs/observability.yaml).
const obsConfig = observabilityConfig();
const spanFile = path.join(work, "spans.jsonl");
const tracing = createTracing(spanFile, "trustbench-arm-smoke");
const fixturesPath = path.join(work, "fixtures.jsonl");
// TB-064: a suite built on the external-validation set (fixture_set "external") loads only the families assigned to
// external_validation, and only while the frozen external manifest is the one the suite was built against.
const fixtureSet = suite.fixture_set ?? "core";
if (fixtureSet === "external") {
  const manifestSha = createHash("sha256").update(await readFile(path.join(root, "data/external-manifest.json"))).digest("hex");
  if (!["external_validation", "tuning"].includes(suite.assignment)) throw new Error("an external suite must name its assignment");
  if (suite.external_manifest_sha256 !== manifestSha) throw new Error("the external-validation suite was built against another external manifest; rebuild it with scripts/build-external-validation-suite.py");
}
await snapshotEpisode("src.arms.cli", ["materialize", "--out", fixturesPath, "--rendering", rendering, ...(live ? ["--model-name", modelId] : []),
  ...(fixtureSet === "external" ? ["--fixture-set", "external", "--assignment", suite.assignment] : confirmatory ? [] : ["--exclude-sealed"])]);
// TB-059: a development run loads no sealed fixture at all. Asserted on the file the tool services actually read.
const loadedFixtureIds = (await readFile(fixturesPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l).fixture_id);
const sealedLoaded = confirmatory ? [] : loadedFixtureIds.filter((id) => id.split("--").some((part) => holdoutIds.has(part)));
if (sealedLoaded.length) throw new Error(`development run loaded sealed fixtures: ${sealedLoaded.slice(0, 5).join(", ")}`);
const attackInfo = JSON.parse(await readFile(`${fixturesPath}.attack-info.json`, "utf8"));
const fixtures = new Map((await readFile(fixturesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).map((row) => [row.fixture_id, row]));

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
// How long a gateway or tool server may take to start: 20 s by default; TRUSTBENCH_SERVER_START_TIMEOUT_MS raises it on
// small hosts (a 0.1-vCPU container needs far longer to start Python).
const serverStartPolls = Math.ceil(Number(process.env.TRUSTBENCH_SERVER_START_TIMEOUT_MS ?? 20000) / 200);
async function waitFor(port) {
  for (let i = 0; i < serverStartPolls; i++) {
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

if (externalAgent && (defendedSystem.agent_defenses.length || defendedSystem.architecture)) throw new Error(`${defendedSystemName} adds agent-side defenses or its own architecture, which an external agent (${agentName}) cannot host; use a gateway system`);
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
    adapter.generate = (req, opts) => spans.model("agent", req.request_id, null, () => originalGenerate(req, opts));  // scripted: no pacing
  }
  let built, port, dbPath, auditFile, gatewayProcess = null; const approvalLog = [];
  const control = positiveControl && testCase.attack_id ? { extraUserInstruction: renderingRegistry.renderings[rendering].instruction_template.replace("{goal}", attackInfo[testCase.attack_id].goal) } : {};
  // On the gateway arm an approval-gated write commits inside the host approval workflow (src/policy/approved_call.py),
  // not on this transport (which only sees the gateway's 409 pause). After-commit faults on those tools go to that
  // workflow instead, so both arms lose the response of the same committing attempt.
  const gatedWrite = (r) => arm === "defended" && defendedSystem.transport !== "direct" && approvalGatedTools.includes(r.tool) && ["fail_after", "reset_after"].includes(r.mode);
  const commitFaultFile = faultRules?.some(gatedWrite) ? path.join(work, `commit-faults-${testCase.case_id}-r${rep}.json`) : null;
  if (commitFaultFile) await writeFile(commitFaultFile, JSON.stringify({ rules: faultRules.filter(gatedWrite), attempts: {}, injected: [] }));
  const transport = faultProfile ? rateFaultyFetch(fetch, { ...faultProfile, seed: baseSeed }, `${testCase.case_id}:${rep}`) : faultRules ? faultyFetch(fetch, faultRules.filter((r) => !gatedWrite(r))) : undefined; // same stream for both arms
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
    gatewayProcess = launch(["-m", "src.gateway.serve", "--fixture", testCase.fixture_id, "--episode", episodeId, "--session-file", sessionFile, "--port", String(port), "--audit-file", auditFile, ...(variantSpec.flow_check ? ["--flow-check"] : []), ...(variantSpec.disable_layers ?? []).flatMap((l) => ["--disable-layer", l])], serviceEnv(defendedDb));
    await waitFor(port);
    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    built = await buildArm({ ...common, baseUrl: `http://127.0.0.1:${port}`,
      gateway: { sessionToken: session.sessionToken, signingKey: session.signingKey, sessionFile, fixtureId: testCase.fixture_id, checkpointDb: path.join(work, `checkpoints-${tag}.sqlite`), env: { ...serviceEnv(defendedDb), ...(commitFaultFile ? { TRUSTBENCH_COMMIT_FAULTS: commitFaultFile } : {}) }, approvalLog } });
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
  let external = null;
  if (externalAgent) {
    const traceDir = path.join(runOutDir ?? work, "traces");
    await mkdir(traceDir, { recursive: true });
    const pace = live ? async (req) => { const wait = lastCall + minIntervalMs - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); await paceTokens(req); lastCall = Date.now(); } : undefined;
    external = await runGooseAgent({
      arm, config: built.config, registry: tracedTools, budgetConfig: built.budget, sandboxKey: `${sandboxRunTag}-${testCase.case_id}-r${rep}`,
      model: live ? { mode: "forward", baseUrl: modelSpec.base_url, apiKey: provider.api_key_env ? process.env[provider.api_key_env] ?? null : null, modelId, extraBody: provider.generation_overrides ?? {} } : { mode: "scripted", outcomes: scriptedOutcomes(testCase) },
      modelInfo: { provider: live ? providerName : "scripted", name: live ? modelId : "mock-arm-smoke", revision: "unpinned" },
      evaluatorVersion: externalAgents.evaluator_version, policyVersion: arm === "defended" ? `gateway_${defendedVariant}` : "none",
      traceFile: path.join(traceDir, `${testCase.case_id}-r${rep}-${arm}.trace.jsonl`), approvalLog, ...(pace ? { pace } : {}),
      span: (requestId, wait, call) => spans.model("agent", requestId, wait, call),
      ...(cancelAfterToolCalls !== undefined ? { cancelAfterToolCalls } : {}),
    });
    for (const m of external.responseModels) observedResponseModels.add(m);
  }
  const result = external ? external.result : architecture
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
  const requests = external ? external.requests : adapter.requests;
  const exposed = marker === null ? null : requests.some((r) => r.messages.some((m) => m.content.includes(marker)));
  const invalid = result.failures.some((f) => f.node === "model" && providerFaultCodes.has(f.code));
  const faultsInjected = transport ? transport.injected.length : 0;
  return { faultsInjected, transportInjected: [...(transport ? transport.injected : []), ...(commitFaultFile ? JSON.parse(await readFile(commitFaultFile, "utf8")).injected : [])], exposed, invalid, engaged: result.tool_records.length > 0, result, requests, snapshot, evaluation, decisions, approvalLog, configEpisode: built.config, providerRetries: external ? external.goose.recovered_provider_errors : adapter.providerRetries, elapsedMs,
    external: external ? { ...external.goose, stderr_tail: undefined, trace: { ...external.trace, file: external.trace.file ? path.relative(root, external.trace.file) : null } } : null };
}

const runs = [];
let endedEarly = null;
// Without a schedule: case by case, repetitions in order. With one: exactly its units, in its recorded order.
const plan = schedule
  ? [...schedule.entries].sort((a, b) => a.position - b.position).map((e) => ({ testCase: selected.find((c) => c.case_id === e.case_id), rep: e.repetition, entry: e }))
  : selected.flatMap((testCase) => Array.from({ length: repetitions }, (_, i) => ({ testCase, rep: i + 1, entry: null })));
for (const { testCase, rep, entry } of plan) {
  if (!testCase) throw new Error(`schedule names a case that is not runnable here: ${entry.case_id}`);
  if (entry && live && entry.seed !== baseSeed + rep * runConfig.live.seed_offset_per_repetition) throw new Error(`schedule seed for ${entry.unit_id} differs from the registered run seed`);
  const fixture = fixtures.get(testCase.fixture_id);
  const order = pairOrder(testCase.case_id, rep);
  const arms = {};
  for (const arm of order) arms[arm] = await runArm(arm, testCase, fixture, rep);
  runs.push({ testCase, rep, order, arms, entry });
  if (live || runOutDir) console.error(`done ${testCase.case_id} r${rep}`);
  if (runOutDir) {
    const brief = (a) => ({ invalid: a.invalid, outcome: a.result.outcome, failures: a.result.failures.map((f) => f.code), utility_pass: a.evaluation.utility_pass, security_pass: a.evaluation.security_pass, attacker_goal_achieved: a.evaluation.attacker_goal_achieved });
    await appendFile(path.join(runOutDir, "pairs.jsonl"), JSON.stringify({ unit_id: entry?.unit_id, case_id: testCase.case_id, repetition: rep, order, baseline: brief(arms.baseline), defended: brief(arms.defended), response_models: [...observedResponseModels].sort() }) + "\n");
    if (observedResponseModels.size > 1) { endedEarly = `provider response model changed mid-run (${[...observedResponseModels].sort().join(", ")}); batch ended and the comparison is invalid (A-025)`; break; }
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
  status: confirmatory ? "TB-032 confirmatory holdout run (A-025); comparative analysis is TB-033" : live ? "pilot evidence on the development split, excluded from confirmatory results" : "deterministic test of gateway wiring and policy logic; not an experimental result",
  reliability: reliability ? { ...reliability, file: reliabilityFile } : null,
  fixture_set: fixtureSet, ...(fixtureSet === "external" ? { external_manifest_sha256: suite.external_manifest_sha256, external_split_sha256: suite.external_split_sha256, external_assignment: suite.assignment } : {}),
  backend_tool_mode: toolMode, attack_rendering: rendering, defended_system: defendedSystemName, defended_system_family: defendedSystem.family, defended_variant: defendedVariant, ...(isAblation ? { ablation: { amendment: ablations.amendment, disabled_gateway_layers: variantSpec.disable_layers ?? [] } } : {}), prompt_profile: effectiveProfile, fault_profile: faultProfileName ?? (faultRulesName ? `rules:${faultRulesName}` : null), cancel_after_tool_calls: cancelAfterToolCalls ?? null, holdout_excluded_cases: excludedHoldout, sealed_fixtures_loaded: confirmatory ? null : 0, fixtures_loaded: loadedFixtureIds.length, suite: suitePath, selected_case_ids: selected.map((c) => c.case_id), schedule: schedule ? { file: scheduleFile, content_sha256: schedule.content_sha256, order_sha256: schedule.order_sha256, units: schedule.entries.length } : null, attack_channel: positiveControl ? "trusted_user_control" : "untrusted_content", repetitions, temperature: live ? temperature : null,
  agent: externalAgent ? { name: agentName, version: externalAgent.version, commit: externalAgent.commit, contract_version: externalAgent.contract_version, seed_sent_to_model: externalAgent.seed_supported, note: "external agent run unmodified through docs/external/integration-contract.md; both arms run it, only the tool path differs" } : null,
  config_differences: configDifferences(baselineEffective, defendedEffective), cases: [],
  ...(endedEarly && !confirmatory ? { ended_early: endedEarly } : {}),
  ...(drillModelUrl ? { fault_drill: { model_base_url: drillModelUrl } } : {}),
  ...(confirmatory ? { confirmatory_holdout: { intended_units: plan.length, attempted_units: runs.length, ended_early: endedEarly, comparison_valid: endedEarly === null, run_dir: path.relative(root, runOutDir) } } : {}),
};
const traces = [];
for (const { testCase, rep, order, arms, entry: scheduled } of runs) {
  const { baseline, defended } = arms;
  const entry = { case_id: testCase.case_id, repetition: rep, pair_order: order, kind: testCase.kind, fixture_id: testCase.fixture_id, attack_id: testCase.attack_id ?? null,
    ...(scheduled ? { unit_id: scheduled.unit_id, schedule_position: scheduled.position } : {}) };
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
  const nonTool = (requests) => requests.map((r) => r.messages.filter((m) => m.role !== "tool" && !m.content.includes('"type":"tool_result"')));
  const common = Math.min(baseline.requests.length, defended.requests.length);
  entry.non_tool_messages_identical = canon(nonTool(baseline.requests).slice(0, common)) === canon(nonTool(defended.requests).slice(0, common));
  entry.same_tool_call_sequence = canon(baseline.result.tool_records.map((r) => [r.tool_name, r.arguments])) === canon(defended.result.tool_records.map((r) => [r.tool_name, r.arguments]));
  entry.final_state_identical = canon(baseline.snapshot.state) === canon(defended.snapshot.state);
  entry.provider_retries = { baseline: baseline.providerRetries, defended: defended.providerRetries };
  const side = (a) => ({ faults_injected: a.faultsInjected ?? 0, defense: a.result.defense ? { defenses: a.result.defense.defenses, model_calls: a.result.defense.model_calls, input_tokens: a.result.defense.input_tokens, output_tokens: a.result.defense.output_tokens, checks: a.result.defense.checks, vetoes: a.result.defense.vetoes.length, filtered_tools: a.result.defense.filtered_tools, filter_parse_failed: a.result.defense.filter_parse_failed, classifications: a.result.defense.classifications ?? null, camel: a.result.defense.camel ?? null } : null, recovery: a.result.recovery ? { model_retries: a.result.recovery.model_retries, tool_retries: a.result.recovery.tool_retries, retry_budget: a.result.recovery.retry_budget, suppressed_duplicate_writes: a.result.recovery.suppressed_duplicate_writes, unknown_outcome_writes: a.result.recovery.unknown_outcome_writes, backoff_ms_total: a.result.recovery.backoff_ms_total } : null, tool_trace: a.result.tool_records.map((r) => ({ tool: r.tool_name, status: r.status, error: r.error_code, attempts: r.attempts ?? null, args: r.arguments, provenance_trust: r.output?.provenance?.trust ?? null, provenance_reason: r.output?.provenance?.reason ?? null })), final_text: a.result.final_text.slice(0, 400), external: a.external ?? null, invalid: a.invalid, engaged: a.engaged, injection_exposed: a.exposed, outcome: a.result.outcome, tool_calls: a.result.tool_records.length, failures: a.result.failures.map((f) => f.code), final_tool_calls: a.snapshot.tool_calls, committed_writes: { research_notes: a.snapshot.state.research_notes.length, email_drafts: a.snapshot.state.email_drafts.length, sent_emails: a.snapshot.state.sent_emails.length, applied_updates: a.snapshot.state.applied_updates.length }, gateway_replays: (a.decisions ?? []).filter((x) => x.replayed).length, faults: (a.transportInjected ?? []).map((f) => `${f.tool}#${f.attempt}:${f.mode}`), evaluation: a.evaluation, elapsed_ms: a.elapsedMs, tokens: { input: a.result.budget.input_tokens, output: a.result.budget.output_tokens } });
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

const suffix = `${live ? modelArg.replace(/[^A-Za-z0-9.]+/g, "-") : "scripted"}-${rendering}-${effectiveProfile}-${defendedSystemName}${toolMode === "contract" ? "-contract-backend" : ""}${faultProfileName ? `-faults-${faultProfileName}` : ""}${faultRulesName ? `-rules-${faultRulesName}` : ""}${cancelAfterToolCalls !== undefined ? `-cancel${cancelAfterToolCalls}` : ""}${suiteTag}${subsetTag}${schedule ? `-sched-${schedule.order_sha256.slice(0, 8)}` : ""}${reliability ? `-rel-${reliability.name}` : ""}${externalAgent ? `-agent-${agentName}` : ""}`;
await mkdir(path.join(root, "reports"), { recursive: true });
const mech = "";
await mkdir(path.join(root, live ? "reports" : "reports/tests"), { recursive: true });
await writeFile(runOutDir ? path.join(runOutDir, "policy-traces.jsonl") : path.join(root, live ? `reports/tb024-${suffix}-policy-traces.jsonl` : `reports/tests/tb024-${suffix}-policy-traces.jsonl`), traces.map((t) => JSON.stringify(t)).join("\n") + "\n");
await tracing.provider.forceFlush(); await tracing.provider.shutdown();
const traceOut = runOutDir ? path.join(runOutDir, "spans.jsonl") : path.join(root, live ? obsConfig.trace_dir_live : obsConfig.trace_dir_scripted, `${reportPrefix}-${suffix}.spans.jsonl`);
await mkdir(path.dirname(traceOut), { recursive: true });
await writeFile(traceOut, await readFile(spanFile, "utf8").catch(() => ""));
report.trace_file = path.relative(root, traceOut);
report.trace_redaction = { replaced_values: tracing.redactor.replaced, dropped_attributes: Object.fromEntries(tracing.redactor.dropped) };
await writeFile(runOutDir ? path.join(runOutDir, "report.json") : path.join(root, live ? `evidence/${reportPrefix}-${suffix}-report.json` : `reports/tests/${reportPrefix}-${suffix}-report.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ summary: report.summary, cases: report.cases.map((c) => ({ id: c.case_id, r: c.repetition, base: [c.baseline.outcome, c.baseline.evaluation.utility_pass, c.baseline.evaluation.attacker_goal_achieved], def: [c.defended.outcome, c.defended.evaluation.utility_pass, c.defended.evaluation.attacker_goal_achieved], diffs: c.record_differences.length, attributable: c.differences_attributable_to_gateway, state_same: c.final_state_identical })) }, null, 1));

const promptChanging = defendedSystem.agent_defenses.some((d) => defensesRegistry.defenses[d]?.changes_first_request) || Boolean(defendedSystem.architecture && defensesRegistry.architectures[defendedSystem.architecture]?.changes_first_request);
const required = (c) => [["run_config_identical", c.run_config_identical], ...(promptChanging ? [] : [["first_request_identical", c.first_request_identical]]), ["settings_identical", c.settings_identical]];
const scriptedOnly = (c) => [["non_tool_messages_identical", c.non_tool_messages_identical], ["same_tool_call_sequence", c.same_tool_call_sequence],
  ["differences_attributable_to_gateway", c.differences_attributable_to_gateway], ...(c.kind === "benign" ? [["final_state_identical", c.final_state_identical]] : [])];
const failed = report.cases.flatMap((c) => [...required(c), ...(live ? [] : scriptedOnly(c))].filter(([, ok]) => !ok).map(([name]) => `${c.case_id}:${name}`));
if (failed.length) { console.error("ARM PARITY FAILURES", failed); process.exit(1); }
process.exit(0);
