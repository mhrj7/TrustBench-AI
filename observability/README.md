# Observability (TB-027)

Every arm run of `scripts/run-arm-smoke.mjs` emits OpenTelemetry spans (`@opentelemetry/api` + `sdk-trace-base`), exported
as JSON lines: one object per span. Live runs write to `observability/traces/`, scripted test runs to `reports/tests/traces/`,
and each report records its `trace_file` and `trace_redaction` counts.

## Spans

| Span | Parent | What it times | Key attributes |
| --- | --- | --- | --- |
| `agent.run` | none (one trace per run) | the whole arm run, setup to evaluation | `run.id`, `case.id`, `arm`, `defended.system`, `run.outcome`, `run.queue_ms_total`, `run.retry_backoff_ms`, evaluation verdicts |
| `model.call` | `agent.run` | one provider request, including the wait before it | `model.role` (agent / defense), tokens, `queue.ms` (pacing wait, so user latency includes queueing), `model.finish_reason` |
| `tool.call` | `agent.run` | one tool execution attempt (retries are separate spans) | `tool.name`, `tool.class` (`retrieval` for read tools, `write`), `tool.attempt`, `tool.status`, `tool.error_code`, `tool.arguments_sha256`, `tool.output_bytes` |
| `policy.decision` | `agent.run` | the gateway's time to decide (`policy.ms`), from its timed audit | `policy.decision`, `policy.reason`, `policy.executed`, `policy.backend_ms` |

Every span carries `run.id`; spans correlate to a run through it and through their trace.

## Redaction

Spans are content-free by design: tool outputs, prompts and argument values are never attributes (arguments appear only as
a SHA-256). At export, attributes outside the allowlist in `configs/observability.yaml` are dropped, and every remaining
string is scanned for registered sensitive fixture values, which are replaced with `[REDACTED]`. The sensitive set is built
from the data files (attack seed-state additions, named benign fixture fields), not from code; sealed holdout fixtures are
never read for it.

## Acceptance check

`npm run verify:observability` (`scripts/verify-observability.mjs`, logic in `src/observability/check.ts`) checks every span
file: exactly one `agent.run` root per trace, every span's `run.id` equals its root's, every parent exists in the same trace,
only allowlisted attributes, queue timing on every model span, and none of the sensitive values anywhere in the file. It
writes `observability/tb027-report.json`. `npm run test:observability` covers redaction of a canary forced into an attribute,
the checker's negative cases, and queue timing.
