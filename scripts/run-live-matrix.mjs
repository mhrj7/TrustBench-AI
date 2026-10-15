// Runs the registered live matrix (configs/live-matrix.yaml) for one lane, sequentially, via scripts/run-arm-smoke.mjs.
import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lane = process.argv[process.argv.indexOf("--lane") + 1];
const matrix = JSON.parse(await readFile(path.join(root, "configs/live-matrix.yaml"), "utf8"));
if (!matrix.lanes[lane]) throw new Error(`unknown lane ${lane}; known: ${Object.keys(matrix.lanes).join(", ")}`);
const registry = JSON.parse(await readFile(path.join(root, "protocol/experiment-registry.yaml"), "utf8"));
const suite = JSON.parse(await readFile(path.join(root, "tests/arms/smoke-cases.json"), "utf8"));
const attackCases = suite.cases.filter((c) => c.kind === "attack" && !c.scripted_only).map((c) => c.case_id).join(",");
const log = path.join(root, `.tool-state/matrix-${lane}.log`);
await writeFile(log, "");

const runOne = (args) => new Promise((resolve) => {
  const child = spawn("node", ["scripts/run-arm-smoke.mjs", "--work-dir", `.tool-state/arms-${lane}`, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => appendFile(log, d)); child.stderr.on("data", (d) => appendFile(log, d));
  child.on("close", (code) => resolve(code));
});

for (const model of matrix.lanes[lane]) {
  const cfg = matrix.models[model];
  let quotaExhausted = false;
  for (const profile of matrix.prompt_profiles) for (const rendering of matrix.renderings) {
    if (quotaExhausted) break;
    if (rendering.profiles && !rendering.profiles.includes(profile)) continue;
    const configured = cfg.repetitions === "registry" ? registry.repetitions_per_pair : cfg.repetitions;
    const reps = Math.min(configured, rendering.repetitions_cap ?? Infinity);
    const args = ["--model", model, "--repetitions", String(reps), "--temperature", String(cfg.temperature), "--min-interval-ms", String(cfg.min_interval_ms), "--attack-rendering", rendering.id, "--prompt-profile", profile];
    if (!rendering.include_benign) args.push("--cases", attackCases);
    await appendFile(log, `\n== ${args.join(" ")}\n`);
    const code = await runOne(args);
    await appendFile(log, `\nexit=${code}\n`);
    if (code === 2) quotaExhausted = true; // provider quota: stop this model rather than record availability as results
  }
}
await appendFile(log, "\nLANE_DONE\n");
