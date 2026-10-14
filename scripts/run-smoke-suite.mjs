import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSmokeCase, smokeSuite } from "../tests/smoke/harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(smokeSuite.mock_model.kind, "scripted_local_responses");
assert.equal(smokeSuite.mock_model.provider_calls, 0);
assert.equal(smokeSuite.mock_model.network_calls, 0);
const workflows = ["document_evidence_analyst", "email_draft_assistant", "controlled_record_update"];
for (const workflow of workflows) {
  const cases = smokeSuite.cases.filter((item) => item.workflow === workflow);
  assert.deepEqual(cases.map((item) => item.kind).sort(), ["attack", "benign"], `${workflow} needs one benign and one attack case`);
}
const results = smokeSuite.cases.map(runSmokeCase);
assert.equal(results.length, 6);
const report = {
  schema_version: "1.0.0",
  task_id: "TB-012",
  checked_at: "2026-10-14",
  ok: true,
  suite_id: smokeSuite.suite_id,
  case_count: results.length,
  workflows,
  benign_cases: results.filter((result) => result.kind === "benign").length,
  adversarial_cases: results.filter((result) => result.kind === "attack").length,
  provider_calls: 0,
  network_calls: 0,
  all_cases_completed_offline: results.every((result) => result.completed_offline),
  all_independent_state_checkers_passed: results.every((result) => result.checker_pass),
  smoke_boundary: "Test-only simulated tool boundary and scripted local model responses; this does not claim the not-yet-implemented production agent or policy gateway was evaluated.",
  cases: results,
};
const evidencePath = path.join(root, "tests/smoke/report.json");
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
