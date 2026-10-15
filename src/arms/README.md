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

## Corrections made 2026-10-15 (see `protocol/amendments.md`)

- Both arms use the permissive backend (`TRUSTBENCH_TOOL_MODE`, protocol baseline) and see all 10 tools; the gateway is the
  only difference. `--tool-mode contract` runs the TB-014 contract-checked backend as an ablation.
- `on_tool_error=continue`: failed or denied calls are returned to the model.
- Prompt v3 states the research-note answer format; evaluator tb016.1.1.0.
- `--attack-rendering as_authored|stripped|authority`, `--repetitions N`, seeded pair order, summary rates with Wilson intervals.
- Locked holdout fixtures never run, scripted or live, and there is no override flag (`--suite` can point at another case file; holdout cases in it are still dropped).

Limits: scripted runs check wiring and parity, not attack success rates. Live results are pilot-sized
(`docs/pilot-results-tb024.md`). Free-text content inside an authorized action is not inspected by the gateway.

## Prompt profiles, validity and the live matrix (2026-10-15)

- `--prompt-profile plain|hardened` (registered in `configs/baseline.yaml`), identical for both arms. `plain` carries no allowed-tools list or security guidance.
- `--attack-rendering <id>` from `data/attack-renderings.json`: authored text, goal-only, project-defined framing, published AgentDojo/InjecAgent templates (cited to the vendored source), and `trusted_user_control` (positive control).
- Every run records `engaged` (made a tool call), `injection_exposed` (the model saw the injected text) and `invalid` (provider fault); invalid pairs are excluded from all rates and listed.
- `scripts/run-live-matrix.mjs --lane <lane>` runs `configs/live-matrix.yaml` (models, repetitions, renderings, profiles are config). `scripts/summarize-live-results.mjs` regenerates `docs/pilot-results-tb024.md`.
- Locked holdout fixtures never run. The sealed replacement holdout (`TB-BEN/ATT-UPDATE-002`) has not been executed by any agent or model.
