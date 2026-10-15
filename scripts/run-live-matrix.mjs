// Runs the registered live matrix (configs/live-matrix.yaml) for one lane, sequentially, via scripts/run-arm-smoke.mjs.
import { spawn } from "node:child_process";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lane = process.argv[process.argv.indexOf("--lane") + 1];
const opt = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
// --only-missing skips cells that already have a finished live report (same rule as scripts/summarize-live-results.mjs);
// --profiles / --renderings restrict the lane so it can be split into parallel jobs.
const onlyMissing = process.argv.includes("--only-missing");
const profileFilter = opt("--profiles")?.split(",") ?? null;
const renderingFilter = opt("--renderings")?.split(",") ?? null;
const logTag = opt("--log-tag");
const modelFilter = opt("--models")?.split(",") ?? null;
const matrix = JSON.parse(await readFile(path.join(root, "configs/live-matrix.yaml"), "utf8"));
if (!matrix.lanes[lane]) throw new Error(`unknown lane ${lane}; known: ${Object.keys(matrix.lanes).join(", ")}`);
const registry = JSON.parse(await readFile(path.join(root, "protocol/experiment-registry.yaml"), "utf8"));
const suite = JSON.parse(await readFile(path.join(root, "tests/arms/smoke-cases.json"), "utf8"));
const attackCases = suite.cases.filter((c) => c.kind === "attack" && !c.scripted_only).map((c) => c.case_id).join(",");
const log = path.join(root, `.tool-state/matrix-${lane}${logTag ? `-${logTag}` : ""}.log`);
const finished = new Set();
for (const name of (await readdir(path.join(root, "evidence"))).filter((n) => /^tb024-.*-report\.json$/.test(n))) {
  const r = JSON.parse(await readFile(path.join(root, "evidence", name), "utf8"));
  if (r.mode === "live_model" && r.summary?.validity) finished.add(`${r.model}|${r.prompt_profile}|${r.attack_rendering}`);
}
await writeFile(log, "");

const runOne = (args) => new Promise((resolve) => {
  const child = spawn("node", ["scripts/run-arm-smoke.mjs", "--work-dir", `.tool-state/arms-${lane}${logTag ? `-${logTag}` : ""}`, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => appendFile(log, d)); child.stderr.on("data", (d) => appendFile(log, d));
  child.on("close", (code) => resolve(code));
});

for (const model of matrix.lanes[lane].filter((m) => !modelFilter || modelFilter.includes(m))) {
  const cfg = matrix.models[model];
  let quotaExhausted = false;
  for (const profile of matrix.prompt_profiles) for (const rendering of matrix.renderings) {
    if (quotaExhausted) break;
    if (rendering.profiles && !rendering.profiles.includes(profile)) continue;
    if (profileFilter && !profileFilter.includes(profile)) continue;
    if (renderingFilter && !renderingFilter.includes(rendering.id)) continue;
    if (onlyMissing && finished.has(`${model}|${profile}|${rendering.id}`)) continue;
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
