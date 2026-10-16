# Review dashboard (TB-030)

A Streamlit and Plotly dashboard over the versioned run store. Every number it shows keeps the run IDs behind it, and every
run opens to its raw record: the report file, its SHA-256, and the JSON pointer of the run inside it.

Dependencies: `app/requirements.lock` is the tool lock plus Streamlit, Plotly and websockets, pinned to the same versions
as `src/tools/requirements.lock`; the tool-service sandbox image installs only the tool lock.

```bash
uv pip sync app/requirements.lock --python .venv-tools/bin/python
npm run dashboard:index      # (re)build the run-store index after evidence changes
npm run dashboard            # http://127.0.0.1:8501, shared-demo mode (redacted)
```

## Views

| View | What it shows | Evidence drill-down |
| --- | --- | --- |
| Comparison by configuration | Utility pass, security pass and attacker-goal rate per group (default system × model), with Wilson 95% intervals; a heatmap (two dimensions) or bars with intervals (one) | Pick any row: every run behind it, whether it counted for each metric, and its raw record |
| Run trace | Outcome, evaluator reasons, TB-029 attribution; a timed waterfall from TB-027 spans (model calls, tool calls, policy decisions) or, for runs without spans, an untimed step-order chart; steps with the policy reason the agent received; the gateway audit; the final text | The run's raw record |
| Policy reasons | Gateway decisions by reason (the gateway's audit), or defense denials the agent received (any defense, from tool-trace errors) | Pick any row: the runs that contain it, and their raw records |
| Task outcomes | Outcome counts per group and evaluator reason codes | Pick any outcome or reason code: its runs and raw records |

Sidebar filters: model, system, rendering, profile, case kind, case, arm, outcome. Invalid runs (the report's validity
rule) are excluded unless asked for, and never count toward a metric. The attacker-goal rate counts attack cases only
(`configs/dashboard.yaml`, `metrics`).

## Versioned run store

`app/store.py` reads the live evidence reports (`evidence/tb024-*-report.json`), their TB-027 span files and the TB-029
attribution file. `scripts/dashboard-index.py` pins each file by SHA-256 in `reports/dashboard/run-index.json`; the store
version is the SHA-256 of that list and is shown in the dashboard header. On load the dashboard re-hashes every file: a
changed or missing file is reported, and a raw record whose report changed refuses to open. `npm run verify:dashboard` fails
when the committed index no longer matches the files.

Gateway decisions are not matched to individual steps: suppressed duplicate writes never reach the gateway and retried
reads reach it more than once, so the audit is shown in its own order next to the steps.

## Redaction (shared demos)

The dashboard redacts payloads by default and offers no way to turn that off unless the host sets
`TRUSTBENCH_DASHBOARD_UNREDACTED=1`, so a shared demo cannot reveal raw values. The redaction set is built from data
(`app/redact.py`): the TB-027 sensitive-value set (checked equal to the TypeScript builder), minus values a trusted task
contract itself names, plus the attack-oracle markers of private-data effects, which catch partial copies (part of the
salary ledger line). Matching is case-insensitive and treats every Unicode dash and space variant alike: gpt-oss writes
non-breaking hyphens (U+2011), which exact matching missed in 5 records before this was added.

## Acceptance check and evidence

`npm run verify:dashboard` (`scripts/verify-dashboard.py`) opens every run's raw record and, for every grouping the
dashboard offers (the default and each single dimension, unfiltered, with invalid runs, and per model), recomputes each
aggregate from the raw records of exactly the run IDs it lists. Policy and outcome counts are checked in both directions.
It also scans every redacted record for any spelling variant of a sensitive value. Results:
`evidence/tb030-dashboard-report.json`. `npm run test:dashboard` covers the store (tampered hash, missing file, run-to-record
resolution, span ownership), the view logic, redaction (port equality, partial and variant copies, a non-vacuous leak
check), and the UI through Streamlit's AppTest. The UI test includes a positive control: with the host variable set and
the toggle on, the same secret does appear.

`npm run dashboard:screenshots` captures every view in shared-demo mode with headless Chrome, checks each rendered page
for Streamlit exceptions and sensitive values, and writes `app/screenshots/*.png` with `manifest.json` (SHA-256 per image,
the run or group shown and the selector that chose it from the data).

Limits: the numbers are pilot evidence on the development split, as in the reports; spans (timing) exist only for runs
recorded since TB-027; the dashboard is a local review tool bound to 127.0.0.1, with no authentication.
