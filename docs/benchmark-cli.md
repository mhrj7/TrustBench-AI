# Benchmark CLI and fresh-environment reproduction (TB-037)

`bin/trustbench` (Typer, `src/cli.py`) packages the benchmark: `validate`, `fetch-data`, `smoke [--check]`,
`benchmark <profile>`, `evaluate`, `report [--check]` and `manifest`. Each step is named in `configs/cli/trustbench.yaml`;
benchmark profiles are `configs/cli/benchmark-*.yaml`. The quickstart is in the README.

## What "reproduces" means

- **Smoke results:** `smoke --check` reruns the credential-free scripted smoke suite and arm comparison and compares each output
  with the committed result after removing only the fields listed as volatile (timestamps, run durations, random approval
  request IDs). Everything else, including every verdict, tool trace and summary rate, must be identical.
- **Report schema:** the arm-comparison report is validated against `schemas/arm-report.schema.json`, which all 125 existing
  1.1.0 reports satisfy.
- **Pinned inputs:** `manifest` checks the content hashes in `manifests/pinned.json` (data, sealed suites, locks, the frozen
  configuration manifest, the schema and the protocol); `npm run verify` runs this check.

## Results (`evidence/tb037-fresh-reproduction.json`)

| Environment | Steps | Result |
| --- | --- | --- |
| Fresh clone at `9b47287` (no `node_modules`, venv or vendored data) | quickstart, `fetch-data`, `validate`, `smoke --check`, `manifest`, `report --check`, full `npm run verify` | all exit 0; smoke outputs match the committed results; schema valid; manifest unchanged (18 files); 55 reproduction tests passed |
| Container `trustbench-bench:tb037` from a clean clone (Node v26.5.0, npm 12.0.0, Python 3.14.0) | `validate`, `smoke --check`, `manifest`, `report --check` | exit 0; 2 smoke outputs match; 55 reproduction tests passed |

The first fresh clone (`879a395`) found a defect: the quickstart installed only the root dependencies, so `npm run verify`
failed at the review-site typecheck. `npm run setup` now also installs the site's locked dependencies; the second fresh clone
passes end to end.

## Limits

- Live benchmark runs call a model provider: they need your own key in `.env`, the provider's free-tier quota, and time.
  Only `benchmark --dry-run` is exercised here. Live results also vary between runs (the model is sampled at the frozen
  temperature), so they are not expected to match a committed result exactly.
- The sealed holdouts were each run once and are excluded from every development run; the CLI cannot rerun them.
- The container does not run the review-site browser tests (they use an installed Google Chrome); the fresh-clone
  `npm run verify` does.
