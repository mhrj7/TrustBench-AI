#!/usr/bin/env node
// TB-036 (A-027): run every ablation arm in configs/ablations.yaml on the development suite with the frozen settings
// (model, prompt profile, temperature, pacing, budget, reliability override) and the selection rendering, in parallel
// lanes with one work directory each. Each arm is one paired run against its own baseline. Logs: .tool-state/ablation-<arm>.log.
// Refuses to start unless the live settings equal the frozen copies (scripts/verify-frozen.py).
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = async (p) => JSON.parse(await readFile(path.join(root, p), "utf8"));
const ab = await json("configs/ablations.yaml");
const hc = await json("configs/frozen/holdout-config.json");
const sel = await json("configs/frozen/selection.json");
const pace = (await json("configs/frozen/live-matrix.yaml")).models[hc.model];
const rendering = sel.data.selection_condition.attack_rendering;
const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1].split(",")) : null;
execFileSync(path.join(root, ".venv-tools/bin/python"), ["scripts/verify-frozen.py"], { cwd: root, stdio: "inherit" });

function runOne(system) {
  const args = ["--experimental-strip-types", "--no-warnings", "scripts/run-arm-smoke.mjs", "--model", hc.model, "--defended-system", system,
    "--attack-rendering", rendering, "--prompt-profile", hc.prompt_profile, "--repetitions", String(ab.run.repetitions), "--temperature", String(pace.temperature),
    "--min-interval-ms", String(pace.min_interval_ms), "--reliability", hc.reliability.override_file, "--report-prefix", ab.run.report_prefix, "--work-dir", `.tool-state/ablation-work-${system}`];
  return new Promise((resolve) => {
    const out = createWriteStream(path.join(root, ".tool-state", `ablation-${system}.log`));
    const child = spawn(process.execPath, args, { cwd: root });
    child.stdout.pipe(out); child.stderr.pipe(out);
    child.on("close", (code) => { console.log(`${system}: exit ${code}`); resolve(code); });
  });
}

const queue = ab.run.arms_to_run.filter((s) => !only || only.has(s));
await Promise.all(Array.from({ length: Math.min(ab.run.lanes, queue.length) }, async () => { while (queue.length) await runOne(queue.shift()); }));
console.log("ABLATIONS_DONE");
