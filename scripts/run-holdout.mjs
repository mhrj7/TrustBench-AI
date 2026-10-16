#!/usr/bin/env node
// TB-032 (A-025): the confirmatory holdout run. For each rendering registered in configs/frozen/live-matrix.yaml, a
// TB-028 schedule of the registered holdout suite (registry repetitions), then one guarded run of the frozen
// configuration (run-arm-smoke.mjs --confirmatory-holdout, which refuses without a gate PASS, on any configuration
// difference, and when the rendering already ran). Renderings run in parallel lanes, each in its own work directory.
// Logs: <run dir>/<rendering>.log. Nothing here chooses a setting: every value comes from the frozen configuration.
// --holdout2 (A-026) runs the registered holdout-2 (suite, rendering) pairs instead, into holdout2.confirmatory_run_dir.
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
const h2 = process.argv.includes("--holdout2");
const runDir = h2 ? registry.holdout2.confirmatory_run_dir : registry.holdout.confirmatory_run_dir;
const lanes = Number(process.argv.includes("--lanes") ? process.argv[process.argv.indexOf("--lanes") + 1] : "3");
await mkdir(path.join(root, runDir), { recursive: true });

function runOne({ rendering, suite, tag }) {
  const schedule = `${runDir}/schedule-${tag}.json`;
  execFileSync(path.join(root, ".venv-tools/bin/python"), ["-m", "src.evaluation.repeats", "schedule", "--suite", suite, "--out", schedule, "--confirmatory-holdout"], { cwd: root, stdio: "inherit" });
  const args = ["--experimental-strip-types", "--no-warnings", "scripts/run-arm-smoke.mjs", "--confirmatory-holdout", "--model", hc.model, "--defended-system", hc.defended_system.system,
    "--attack-rendering", rendering, "--prompt-profile", hc.prompt_profile, "--temperature", String(pace.temperature), "--min-interval-ms", String(pace.min_interval_ms),
    "--reliability", hc.reliability.override_file, "--suite", suite, "--schedule", schedule, "--report-prefix", "tb032", "--work-dir", `.tool-state/holdout-work-${tag}`];
  return new Promise((resolve) => {
    const out = createWriteStream(path.join(root, runDir, `${tag}.log`));
    const child = spawn(process.execPath, args, { cwd: root });
    child.stdout.pipe(out); child.stderr.pipe(out);
    child.on("close", (code) => { console.log(`${tag}: exit ${code}`); resolve(code); });
  });
}

const queue = h2
  ? registry.holdout2.runs.map((r) => ({ rendering: r.rendering, suite: registry.holdout2.suites[r.suite], tag: `${r.suite}-${r.rendering}` }))
  : matrix.renderings.map((r) => ({ rendering: r.id, suite: registry.holdout.confirmatory_suite, tag: r.id }));
await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, async () => { while (queue.length) await runOne(queue.shift()); }));
console.log("HOLDOUT_DONE");
