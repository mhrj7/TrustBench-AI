# Tasks and fixtures for the external agent (TB-059)

How the TrustBench development tasks and attacks reach goose 1.55.0 ([native-integration.md](native-integration.md)), and
which ones run end to end. The fixtures, their initial state and the evaluators are the core benchmark's, unchanged. Only
the agent differs.

## How a task reaches goose

| Benchmark input | How goose receives it | Same as the built-in agent |
| --- | --- | --- |
| The task (the fixture's request and contract) | The user prompt, rendered from the registered prompt profile (`configs/baseline.yaml`, `src/arms/prompt.ts`), passed as `goose run -t` | Same text |
| The system prompt | `--system`, the same file for both arms | Same text |
| Documents, records, contacts | Only as tool results: goose reads them by calling the TrustBench tools through the MCP adapter | Same tools, schemas and descriptions |
| The attack | Inside a document or record the fixture seeds (untrusted content), never in the prompt | Same materialized fixture |
| Initial state | The tool backend is reset with the fixture before each run | Same backend and reset |
| Scoring | The unchanged evaluator (`src/evaluators/outcomes_v2.py`, version `tb016.1.3.0`) scores the committed state and the tool records, never goose's text | Same evaluator and version |

goose adds its own built-in system prompt and may summarise or rewrite tool outputs before acting. That is recorded as
the agent's behaviour (its full prompt is hashed per run), not treated as a fixture defect.

## The development suite

`tests/external/fixtures/dev-suite.json` (built and checked by `scripts/build-external-dev-suite.py`) holds a case for
every development fixture: the 25 fixtures of the `tuning` groups in `data/splits.json`, 12 benign and 13 attacks.

- **Reused cases:** cases already in the core suites (`tests/arms/smoke-cases.json` and the stress suites) are reused
  unchanged. A case ID found in more than one suite must be identical in each, or the build fails.
- **Generated cases:** three benign fixtures had no authored case (`TB-BEN-DOC-002`, `TB-BEN-DOC-003`,
  `TB-BEN-EMAIL-002`). Each gets a reference trajectory generated from its own oracle: read the allowed sources, then
  write the oracle's note or draft. The unchanged evaluator passes all three.
- **No sealed fixture:** the suite contains none, and the build fails if a source suite would add one.

## No holdout fixture is loaded

A development run materializes only development fixtures. `--exclude-sealed` drops every fixture and attack in
`holdout_manifest` and `holdout2_manifest`. The runner then reads back the fixture file the tool services load and
stops if any sealed fixture is in it.

Every report records `sealed_fixtures_loaded: 0` and `fixtures_loaded`. A sealed case in a suite is excluded and listed
in `holdout_excluded_cases`.

The tests (`tests/external/fixtures/`) check:
- the materialization, with a positive control that sealed fixtures are present without the exclusion;
- the guard with goose as the agent, on a suite that mixes in a holdout case.

## Results

`scripts/build-task-mapping.py` builds the per-fixture table in `evidence/tb059-task-mapping.json` from the saved runs.

**End to end, scripted.** Every development fixture runs end to end through goose with the unchanged evaluators: all 25,
in 26 cases, both arms. Scripted trajectories replay the same tool calls through goose and through the built-in agent.
The evaluator's verdicts are identical in every case and arm: outcome, utility, security, attacker goal, reason codes
and tool-call count. This shows the tasks, documents, initial state and evaluators reach goose unchanged.

Evidence: `evidence/tb059-scripted/goose/` and `evidence/tb059-scripted/trustbench/`, with their TB-004 traces.

**Live, goose with a model** (nvidia `openai/gpt-oss-20b`, the frozen model, free tier, one repetition; evidence in
`evidence/tb059-goose-live/` and `evidence/tb059-goose-live-retry/`):
- 25 pairs were run; 17 were valid. The other 8 are invalid and not counted, because the provider had not answered when
  the 240 s run limit was reached. That is the same rule as for the built-in agents.
- Those 8 cases were run once more, and 6 of them were valid.
- 24 of the 25 development fixtures have a valid live pair. The exception is `TB-ATT-DOC-008` (case
  `doc-birch-status-wrapped`): the provider timed out on it in both runs. It runs end to end in the scripted comparison
  above, so this is a provider limit, not a mapping limit.
- In the valid pairs goose carried out the delivered tasks through the TrustBench tools, and the evaluator scored them.
  Some write-heavy tasks ended `budget_exhausted` because goose kept calling tools. That is the agent's behaviour,
  recorded as measured.

The live numbers are a pilot on the development split, one repetition each. They are not an estimate of goose's
security or utility; TB-060 and later tasks measure that.

## Tasks goose cannot express

None found. Every development fixture runs end to end.

- **`email-attack-marker-body`:** this case is scripted-only in the core suite, a fixed trajectory that tests one
  detector. It is never run with a model, for goose as for the built-in agent.
- **Invalid live pairs:** a live pair that is invalid because of the provider is listed in the table with its reason. It
  is not a limitation of the mapping.

## Reproduce

```sh
.venv-tools/bin/python scripts/build-external-dev-suite.py --check
TRUSTBENCH_GOOSE_BIN=<pinned goose> node --test tests/external/fixtures/goose-dev-suite.test.ts
.venv-tools/bin/python -m pytest -q tests/external/fixtures
.venv-tools/bin/python scripts/build-task-mapping.py
```
