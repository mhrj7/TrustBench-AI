# Comparison arms (TB-024)

`configs/baseline.yaml` defines everything both arms share; `configs/defended.yaml`
extends it and may override only the `tool_path` block (gateway transport, session
auth, provenance envelope, policy layers, approval workflow, decision trace).
`src/arms/arms.ts#buildArm` builds both arms from the same function: same runner
(`runBaselineAgent`), system prompt (`agent/instructions.md`), user prompt, tool
names/descriptions/schemas (from `capability-manifests.json`), budgets, generation
settings and materialized fixtures (`src/arms/fixtures.py`).

Differences are intended and enumerated: the defended arm talks to the gateway with a
host-issued session, receives provenance-wrapped outputs, is subject to capability and
argument policy, and pauses `apply_record_update` for approval. The pause is resumed by
`src/policy/approved_call.py` (LangGraph interrupt workflow) only when the call matches
the fixture's synthetic approval event exactly.

Run `npm run test:arms` (unit parity plus a 7-case smoke run) or
`npm run verify:arms-smoke`. Outputs: `evidence/tb024-defended-arm-report.json` and the
policy decision traces `reports/tb024-policy-decision-traces.jsonl`.

Limits: the smoke runs use scripted local model outputs, so they check wiring and parity,
not attack success rates. The shared runner stops on the first failed tool call. The baseline
backend still enforces its own task-contract checks (TB-014). Measured comparisons start
in the evaluation phase.
