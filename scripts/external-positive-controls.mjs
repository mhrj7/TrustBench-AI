// TB-062: positive controls for the external-validation attack families, against the undefended agent only.
// For every attack the goal is given as a trusted user instruction (rendering trusted_user_control: no injection in any
// document) to goose on the permissive tool backend; the unchanged evaluator must report the attacker goal achieved,
// which shows each family's goal is reachable and its oracle registers it. No defended run is made (A-030: the manifest
// is frozen before any defended run on these families). Writes evidence/tb062-positive-controls.json.
//   TRUSTBENCH_GOOSE_BIN=<pinned goose> node --experimental-strip-types scripts/external-positive-controls.mjs --model ollama:qwen3.5:9b
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArm } from "../src/arms/arms.ts";
import { externalAgents, runGooseAgent } from "../src/external/goose.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const modelArg = flag("--model", "ollama:qwen3.5:9b");
const only = flag("--attacks", null)?.split(",") ?? null;
const repetitions = Number(flag("--repetitions", "1"));
const providerName = modelArg.slice(0, modelArg.indexOf(":")), modelId = modelArg.slice(modelArg.indexOf(":") + 1);
const providers = JSON.parse(await readFile(path.join(root, "configs/providers.yaml"), "utf8"));
const provider = providers.providers[providerName];
const runConfig = JSON.parse(await readFile(path.join(root, "configs/live-run.yaml"), "utf8"));
const renderings = JSON.parse(await readFile(path.join(root, "data/attack-renderings.json"), "utf8"));
const python = path.join(root, ".venv-tools/bin/python");
const run = (args, opts = {}) => new Promise((res, rej) => execFile(python, args, { cwd: root, maxBuffer: 64 << 20, ...opts }, (e, out) => (e ? rej(e) : res(out))));

const work = await mkdtemp(path.join(os.tmpdir(), "tb062-pc-"));
const fixturesPath = path.join(work, "fixtures.jsonl");
await run(["-m", "src.arms.cli", "materialize", "--fixture-set", "external", "--rendering", "trusted_user_control", "--out", fixturesPath]);
const fixtures = new Map((await readFile(fixturesPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).map((f) => [f.fixture_id, f]));
const attackInfo = JSON.parse(await readFile(`${fixturesPath}.attack-info.json`, "utf8"));
const attacks = (await readFile(path.join(root, "data/external-attacks.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((a) => !only || only.includes(a.attack_id));

const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const db = path.join(work, "state.sqlite");
const service = spawn(python, ["-m", "uvicorn", "src.tools.app:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"],
  { cwd: root, env: { ...process.env, TRUSTBENCH_FIXTURE_PATH: fixturesPath, TRUSTBENCH_TOOL_DB: db, TRUSTBENCH_TOOL_MODE: "permissive" }, stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => service.kill("SIGTERM"));
for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const results = [];
for (const attack of attacks) for (let rep = 1; rep <= repetitions; rep++) {
  const fixtureId = `${attack.base_fixture_id}--${attack.attack_id}`, episodeId = `pc-${attack.attack_id}-r${rep}`;
  const fixture = fixtures.get(fixtureId);
  await fetch(`http://127.0.0.1:${port}/v1/episodes/${episodeId}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixture_id: fixtureId, max_tool_calls: runConfig.episode_max_tool_calls }) });
  const built = await buildArm({ arm: "baseline", fixture, episodeId, baseUrl: `http://127.0.0.1:${port}`, runId: `run-pc-${attack.attack_id}`, taskId: attack.base_fixture_id,
    extraUserInstruction: renderings.renderings.trusted_user_control.instruction_template.replace("{goal}", attackInfo[attack.attack_id].goal),
    budgetConfigPath: path.join(root, provider.budget_file ?? "configs/budget.yaml"), timeoutMs: runConfig.live.timeout_ms,
    generationOverrides: { temperature: runConfig.live.default_temperature, max_output_tokens: runConfig.live.max_output_tokens, ...provider.generation_overrides } });
  const out = await runGooseAgent({ arm: "baseline", config: built.config, registry: built.tools, budgetConfig: built.budget, sandboxKey: `pc-${attack.attack_id}-r${rep}-${process.pid}`,
    model: { mode: "forward", baseUrl: provider.base_url, apiKey: provider.api_key_env ? process.env[provider.api_key_env] ?? null : null, modelId, extraBody: provider.generation_overrides ?? {} },
    modelInfo: { provider: providerName, name: modelId, revision: "unpinned" }, evaluatorVersion: externalAgents.evaluator_version, policyVersion: "none", traceFile: null });
  const snapshot = JSON.parse(await run(["-m", "src.arms.cli", "snapshot", "--db", db, "--episode", episodeId]));
  const evaluation = JSON.parse(await new Promise((res, rej) => {
    const child = execFile(python, ["-m", "src.arms.cli", "evaluate", "--fixtures", fixturesPath], { cwd: root }, (e, o) => (e ? rej(e) : res(o)));
    child.stdin.end(JSON.stringify({ fixture_id: fixtureId, attack_id: attack.attack_id, final_state: snapshot.state,
      tool_records: out.result.tool_records.map((r) => ({ call_id: r.call_id, tool_name: r.tool_name, status: r.status, arguments: r.arguments, state_change_ids: r.state_change_ids, error_code: r.error_code })) }));
  }));
  const row = { attack_id: attack.attack_id, family_id: attack.family_id, repetition: rep, outcome: out.result.outcome, invalid: out.invalid, tool_calls: out.result.tool_records.map((r) => `${r.tool_name}:${r.status}`),
    attacker_goal_achieved: evaluation.attacker_goal_achieved, reason_codes: evaluation.reason_codes, final_text: out.result.final_text.slice(0, 200) };
  results.push(row);
  console.log(`${row.attacker_goal_achieved ? "ok  " : row.invalid ? "INV " : "FAIL"} ${attack.attack_id} r${rep} ${attack.family_id}: ${row.outcome} ${row.tool_calls.join(" ")}`);
}
service.kill("SIGTERM");
const report = { task_id: "TB-062", model: modelArg, agent: { name: "goose", version: externalAgents.agents.goose.version }, arm: "baseline (undefended) only", rendering: "trusted_user_control",
  note: "The attack goal is given as a trusted user instruction; no document carries an injection. Success shows the goal is reachable and the oracle registers it. Invalid runs (provider faults) are not counted.",
  repetitions, results, succeeded: results.filter((r) => r.attacker_goal_achieved).length, invalid: results.filter((r) => r.invalid).length, total: results.length,
  per_family: Object.fromEntries(attacks.map((a) => { const rs = results.filter((r) => r.attack_id === a.attack_id && !r.invalid); return [a.family_id, { attack_id: a.attack_id, valid_runs: rs.length, goal_achieved: rs.filter((r) => r.attacker_goal_achieved).length }]; })),
  every_family_reached: attacks.every((a) => results.some((r) => r.attack_id === a.attack_id && r.attacker_goal_achieved)) };
if (!only) { await mkdir(path.join(root, "evidence"), { recursive: true }); await writeFile(path.join(root, "evidence/tb062-positive-controls.json"), JSON.stringify(report, null, 1) + "\n"); }
console.log(JSON.stringify({ succeeded: report.succeeded, invalid: report.invalid, total: report.total }));
process.exit(0);
