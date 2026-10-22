#!/usr/bin/env node
// TB-064 (A-030): the paired external evaluation. goose alone (baseline) and behind the gateway (defended) on the
// external-validation split: the benign twins once, and the attack cases once per registered rendering (primary,
// secondary, positive control). Each part runs a TB-028 schedule (registry repetitions) through run-arm-smoke.mjs with
// the registered model and the frozen prompt profile, temperature and pacing; nothing here chooses a setting. Parts run
// in lanes, each in its own work directory, into protocol/experiment-registry.yaml external_validation.run_dir/<part>/.
// A part that already has a report is never run again (one pass; no early stop, no rerun for effect).
//   TRUSTBENCH_GOOSE_BIN=<pinned goose> node --experimental-strip-types scripts/run-external-evaluation.mjs [--lanes 2] [--model <fallback>]
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = async (p) => JSON.parse(await readFile(path.join(root, p), "utf8"));
const flag = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const ext = (await json("protocol/experiment-registry.yaml")).external_validation;
const hc = await json("configs/frozen/holdout-config.json");
const matrix = await json("configs/frozen/live-matrix.yaml");
const primary = ext.models.primary.split(" ")[0];
const model = flag("--model", primary);
if (model !== primary && !ext.models.fallback_order.includes(model)) throw new Error(`--model must be the registered primary or a registered fallback (${ext.models.fallback_order.join(", ")})`);
const pace = matrix.models[model] ?? (await json("configs/live-matrix.yaml")).models[model];
if (!pace) throw new Error(`no registered pacing for ${model}`);
if (!ext.evaluation_runs_started) throw new Error("record the start in protocol/experiment-registry.yaml (evaluation_runs_started) and commit it with the schedules before the pass");
const modelTag = model === primary ? "primary" : model.replace(/[^A-Za-z0-9.]+/g, "-");
const runDir = path.join(ext.run_dir, modelTag);
const lanes = Number(flag("--lanes", "2"));
const parts = ext.runs.map((r) => ({ ...r, tag: `${r.suite}-${r.rendering}` }));
await mkdir(path.join(root, runDir), { recursive: true });

function runOne(part) {
  const outDir = path.join(runDir, part.tag);
  if (existsSync(path.join(root, outDir, "report.json"))) { console.log(`${part.tag}: already run, skipped`); return Promise.resolve(0); }
  const schedule = path.join(runDir, `schedule-${part.tag}.json`);
  if (!existsSync(path.join(root, schedule)))
    execFileSync(path.join(root, ".venv-tools/bin/python"), ["-m", "src.evaluation.repeats", "schedule", "--suite", ext.suites[part.suite], "--out", schedule, "--repetitions", String(ext.repetitions_per_pair)], { cwd: root, stdio: "inherit" });
  const args = ["--experimental-strip-types", "--no-warnings", "scripts/run-arm-smoke.mjs", "--agent", "goose", "--model", model,
    "--defended-system", ext.defended_system, "--attack-rendering", part.rendering, "--prompt-profile", hc.prompt_profile,
    "--temperature", String(pace.temperature), "--min-interval-ms", String(pace.min_interval_ms),
    "--suite", ext.suites[part.suite], "--schedule", schedule, "--report-prefix", "tb064",
    "--work-dir", `.tool-state/external-eval-${modelTag}-${part.tag}`, "--out-dir", outDir];
  return new Promise((resolve) => {
    const out = createWriteStream(path.join(root, runDir, `${part.tag}.log`));
    const child = spawn(process.execPath, args, { cwd: root, env: process.env });
    child.stdout.pipe(out); child.stderr.pipe(out);
    child.on("close", (code) => { out.end(); console.log(`${part.tag}: exit ${code}`); resolve(code); });
  });
}

const queue = [...parts];
await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, async () => { while (queue.length) await runOne(queue.shift()); }));
console.log("EXTERNAL_EVALUATION_DONE");
