// Runs one lane of configs/defense-comparison.yaml sequentially through scripts/run-arm-smoke.mjs.
import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lane = process.argv[process.argv.indexOf("--lane") + 1];
const cfg = JSON.parse(await readFile(path.join(root, "configs/defense-comparison.yaml"), "utf8"));
const spec = cfg.lanes[lane];
if (!spec) throw new Error(`unknown lane ${lane}; known: ${Object.keys(cfg.lanes).join(", ")}`);
const suite = JSON.parse(await readFile(path.join(root, "tests/arms/smoke-cases.json"), "utf8"));
const cases = suite.cases.filter((c) => !c.scripted_only).map((c) => c.case_id).join(",");
const log = path.join(root, `.tool-state/comparison-${lane}.log`);
await writeFile(log, "");
for (const system of spec.systems) {
  const args = ["scripts/run-arm-smoke.mjs", "--work-dir", `.tool-state/arms-cmp-${lane}`, "--model", spec.model, "--repetitions", String(spec.repetitions),
    "--temperature", String(cfg.temperature), "--min-interval-ms", String(spec.min_interval_ms), "--attack-rendering", cfg.attack_rendering, "--defended-system", system, "--cases", cases];
  await appendFile(log, `\n== ${system}\n`);
  const code = await new Promise((resolve) => { const c = spawn("node", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); c.stdout.on("data", (d) => appendFile(log, d)); c.stderr.on("data", (d) => appendFile(log, d)); c.on("close", resolve); });
  await appendFile(log, `\nexit=${code}\n`);
  if (code === 2) break;
}
await appendFile(log, "\nLANE_DONE\n");
