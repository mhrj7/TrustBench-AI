#!/usr/bin/env node
// TB-032 (A-025): the confirmatory holdout run. For each rendering registered in configs/frozen/live-matrix.yaml, a
// TB-028 schedule of the registered holdout suite (registry repetitions), then one guarded run of the frozen
// configuration (run-arm-smoke.mjs --confirmatory-holdout, which refuses without a gate PASS, on any configuration
// difference, and when the rendering already ran). Renderings run in parallel lanes, each in its own work directory.
// Logs: <run dir>/<rendering>.log. Nothing here chooses a setting: every value comes from the frozen configuration.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = async (p) => JSON.parse(await readFile(path.join(root, p), "utf8"));
const registry = await json("protocol/experiment-registry.yaml");
const hc = await json("configs/frozen/holdout-config.json");
const matrix = await json("configs/frozen/live-matrix.yaml");
const pace = matrix.models[hc.model];
const runDir = registry.holdout.confirmatory_run_dir;
const lanes = Number(process.argv.includes("--lanes") ? process.argv[process.argv.indexOf("--lanes") + 1] : "3");
await mkdir(path.join(root, runDir), { recursive: true });

function runOne(rendering) {
  const schedule = `${runDir}/schedule-${rendering}.json`;
  execFileSync(path.join(root, ".venv-tools/bin/python"), ["-m", "src.evaluation.repeats", "schedule", "--suite", registry.holdout.confirmatory_suite, "--out", schedule, "--confirmatory-holdout"], { cwd: root, stdio: "inherit" });
  const args = ["--experimental-strip-types", "--no-warnings", "scripts/run-arm-smoke.mjs", "--confirmatory-holdout", "--model", hc.model, "--defended-system", hc.defended_system.system,
    "--attack-rendering", rendering, "--prompt-profile", hc.prompt_profile, "--temperature", String(pace.temperature), "--min-interval-ms", String(pace.min_interval_ms),
    "--reliability", hc.reliability.override_file, "--suite", registry.holdout.confirmatory_suite, "--schedule", schedule, "--report-prefix", "tb032", "--work-dir", `.tool-state/holdout-work-${rendering}`];
  return new Promise((resolve) => {
    const out = createWriteStream(path.join(root, runDir, `${rendering}.log`));
    const child = spawn(process.execPath, args, { cwd: root });
    child.stdout.pipe(out); child.stderr.pipe(out);
    child.on("close", (code) => { out.end(`\nEXIT ${code}\n`); console.log(`${rendering}: exit ${code}`); resolve(code); });
  });
}

const queue = matrix.renderings.map((r) => r.id);
await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, async () => { while (queue.length) await runOne(queue.shift()); }));
console.log("HOLDOUT_DONE");
