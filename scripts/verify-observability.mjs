// TB-027 acceptance check: every span links to its run, and no seeded secret canary appears in any exported span.
// Usage: node scripts/verify-observability.mjs [span files...]  (default: every *.spans.jsonl in the configured trace dirs)
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observabilityConfig, sensitiveValues } from "../src/observability/tracing.ts";
import { checkSpans } from "../src/observability/check.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = observabilityConfig();
const secrets = sensitiveValues(cfg);
const args = process.argv.slice(2);
const reportAt = args.indexOf("--report");
const reportOut = reportAt >= 0 ? args[reportAt + 1] : "observability/tb027-report.json";
let files = args.filter((a, i) => !a.startsWith("--") && !(reportAt >= 0 && i === reportAt + 1));
if (!files.length) for (const dir of [cfg.trace_dir_live, cfg.trace_dir_scripted]) {
  const names = await readdir(path.join(root, dir)).catch(() => []);
  files.push(...names.filter((n) => n.endsWith(".spans.jsonl")).map((n) => path.join(dir, n)));
}
if (!files.length) { console.error("no span files to check"); process.exit(1); }

{
  const results = [];
  for (const f of files) { const r = checkSpans(await readFile(path.resolve(root, f), "utf8")); results.push({ file: path.relative(root, path.resolve(root, f)), ok: r.problems.length === 0, ...r.stats, problems: r.problems.slice(0, 20) }); }
  const report = { task_id: "TB-027", checked_at: new Date().toISOString(), sensitive_values_checked: secrets.length, files: results, ok: results.every((r) => r.ok) };
  await mkdir(path.dirname(path.resolve(root, reportOut)), { recursive: true });
  await writeFile(path.resolve(root, reportOut), JSON.stringify(report, null, 2) + "\n");
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.file}: ${r.spans} spans, ${r.runs} runs, model ${r.model_spans}, tool ${r.tool_spans} (retrieval ${r.retrieval_spans}), policy ${r.policy_spans}${r.problems.length ? "\n   " + r.problems.join("\n   ") : ""}`);
  process.exit(report.ok ? 0 : 1);
}
