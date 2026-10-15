import { mkdir, rm, writeFile } from "node:fs/promises";

const runDir = new URL("../runs/baseline-pilot/", import.meta.url);
for (const name of ["raw-runs.jsonl", "outcomes.jsonl", "report.json", "manifest.json", "preflight-failures.json"]) {
  await rm(new URL(name, runDir), { force: true });
}
await rm(new URL("state/", runDir), { recursive: true, force: true });
await mkdir(runDir, { recursive: true });
await mkdir(new URL("state/", runDir), { recursive: true });
await writeFile(new URL("raw-runs.jsonl", runDir), "", { mode: 0o600 });
await writeFile(new URL("preflight-failures.json", runDir), `${JSON.stringify({
  schema_version: "1.0.0",
  task_id: "TB-017",
  note: "No excluded operational attempts were recorded for this clean run.",
  failures: [],
}, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ task_id: "TB-017", prepared: true, repeats: 2, tuning_cases: 8, scheduled_runs: 16 }));
