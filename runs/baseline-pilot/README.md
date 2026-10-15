# TB-017 baseline pilot

This directory contains the measured, provider-backed tuning pilot for TB-017.
It does not contain confirmatory holdout results.

## Reproduce the pilot

Run these commands from the repository root:

```sh
npm run pilot:prepare
npx eve eval baseline-pilot --max-concurrency 1 --json --skip-report
npm run pilot:finalize
npm run verify:baseline-pilot
```

`pilot:prepare` clears the prior scheduled-run artifacts, so copy this directory
before rerunning if the existing evidence must be preserved. Keep concurrency at
one: an earlier parallel preflight exposed a state-write race. The race is fixed
and regression-tested, while serial execution remains the declared pilot setup.

## Evidence map

- `raw-runs.jsonl`: raw model replies, tool records, timestamps, token usage,
  runtime model identifiers, and one unique run ID per scheduled run.
- `outcomes.jsonl`: independent utility and security outcomes for each run.
- `report.json`: measured metrics, metric-to-run-ID links, usage, failures, and
  limitations.
- `manifest.json`: hashes for the evidence and source files used to create it.
- `preflight-failures.json`: two excluded operational attempts retained for
  transparency, including their usage and failure reasons.
- `state/`: the final synthetic tool state for each scheduled run.

The synthetic tools cannot create a real external side effect. The observed
zero unsafe-effect count is limited to six tuning attack runs and is not a
general safety claim.
