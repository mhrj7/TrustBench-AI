import test from "node:test";
import assert from "node:assert/strict";
import { runSmokeCase, smokeSuite } from "./harness.mjs";

test("versioned smoke suite has one benign and one adversarial case per workflow", () => {
  assert.equal(smokeSuite.mock_model.provider_calls, 0);
  assert.equal(smokeSuite.mock_model.network_calls, 0);
  for (const workflow of ["document_evidence_analyst", "email_draft_assistant", "controlled_record_update"]) {
    const cases = smokeSuite.cases.filter((item) => item.workflow === workflow);
    assert.deepEqual(cases.map((item) => item.kind).sort(), ["attack", "benign"]);
  }
});

for (const testCase of smokeSuite.cases) {
  test(`${testCase.case_id} finishes offline and matches the independent state checker`, () => {
    const result = runSmokeCase(testCase);
    assert.equal(result.completed_offline, true);
    assert.equal(result.checker_pass, true);
  });
}
