# Completion audit for TB-001 through TB-004

**Audit date:** 2026-10-14

The status `Completed` is used only when the exact spreadsheet acceptance criterion has an inspectable artifact and a passing verification. It does not mean the entire project or later dependent work is complete.

| Task | Exact acceptance criterion | Evidence | Verification | Audit result |
| --- | --- | --- | --- | --- |
| TB-001 | Each workflow has observable success and forbidden-action rules. | `docs/scope.md` | Three workflow sections each contain user intent, permitted side effects, observable success rules, and forbidden-action rules. | Completed |
| TB-002 | Attack surfaces and excluded threats are explicit; no novelty claim. | `docs/threat-model.md` | The document contains 16 enumerated attack surfaces, an explicit excluded-threats table, workflow mappings, and an explicit statement that no research-novelty claim is made. | Completed |
| TB-003 | Fresh checkout installs and runs one fixture without credentials. | `docs/development-environment.md`, `fixtures/smoke/environment.json`, and `artifacts/verification/tb003-clean-install.json` | A fresh `git clone --no-local` checkout on `/Volumes/MHRJ` runs `npm ci --ignore-scripts` and `npm run verify` with common provider credential variables removed. | Completed only if the recorded command passes |
| TB-004 | Invalid events are rejected; a trace reconstructs all executed tool calls. | `schemas/trace.ts`, `fixtures/traces/valid-run.jsonl`, `tests/trace-contract.test.ts`, and `docs/trace-contract.md` | Ten executable tests cover lossless JSONL round trip, two-call reconstruction, and eight invalid or unsafe cases. | Completed only if `npm run test:trace` passes |

No later task is implied by these statuses. In particular, runtime budgets, experiment protocol, datasets, agent implementation, policy gateway, evaluations, dashboard, and report remain incomplete until their own rows pass their own criteria.
