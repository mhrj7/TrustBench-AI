#!/usr/bin/env node
// TB-031 reliability sweep (A-024): runs every configuration in configs/reliability-sweep.yaml with the frozen system,
// model, profile and rendering, in parallel lanes, each in its own work directory. Logs go to .tool-state/sweep-<name>.log.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sweep = JSON.parse(await readFile(path.join(root, "configs/reliability-sweep.yaml"), "utf8"));
const sel = JSON.parse(await readFile(path.join(root, "configs/frozen/selection.json"), "utf8"));
const matrix = JSON.parse(await readFile(path.join(root, "configs/live-matrix.yaml"), "utf8"));
const { system, model, prompt_profile: profile } = sel.selected;
const rendering = sel.data.selection_condition.attack_rendering;
const pace = matrix.models[model];
const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1].split(",")) : null;
const configs = sweep.configurations.filter((c) => !only || only.has(c.name));
await mkdir(path.join(root, ".tool-state/sweep"), { recursive: true });

function runOne(c) {
  return new Promise(async (resolve) => {
    const file = path.join(".tool-state/sweep", `${c.name}.json`);
    await writeFile(path.join(root, file), JSON.stringify(c, null, 2));
    const args = ["--experimental-strip-types", "--no-warnings", "scripts/run-arm-smoke.mjs", "--model", model, "--defended-system", system,
      "--attack-rendering", rendering, "--prompt-profile", profile, "--repetitions", String(sweep.repetitions), "--temperature", String(pace.temperature),
      "--min-interval-ms", String(pace.min_interval_ms), "--reliability", file, "--report-prefix", sweep.report_prefix, "--work-dir", `.tool-state/sweep-work-${c.name}`];
    const log = path.join(root, ".tool-state", `sweep-${c.name}.log`);
    const { createWriteStream } = await import("node:fs");
    const out = createWriteStream(log);
    const child = spawn(process.execPath, args, { cwd: root });
    child.stdout.pipe(out); child.stderr.pipe(out);
    child.on("close", (code) => { out.write(`\nEXIT ${code}\n`); out.end(); console.log(`${c.name}: exit ${code}`); resolve(code); });
  });
}

const queue = [...configs];
const lanes = Array.from({ length: Math.min(sweep.parallel_lanes, queue.length) }, async () => { while (queue.length) await runOne(queue.shift()); });
await Promise.all(lanes);
console.log("SWEEP_DONE");
