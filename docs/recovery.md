# Retries and bounded recovery (TB-025)

Implemented in `src/agent/recovery.ts`, used by the shared runner (`runBaselineAgent`) for **both** comparison arms, configured by
`configs/recovery.yaml`. Without a `recovery` argument the runner keeps the TB-015 behavior (no retries).

## Rules

| Case | Behavior |
| --- | --- |
| Read-class tool, transient failure (HTTP 408/429/502/503/504, connection reset, per-attempt timeout) | Retried with exponential backoff and seeded full jitter, up to `max_attempts_per_call` and the run's `limits.max_retries`. |
| Hard limits (the episode tool-call cap is HTTP 429 `episode_tool_call_limit_exceeded`), 4xx policy denials, schema errors | Never retried. |
| Write-class tool, any failure | **One attempt only.** The schema forbids enabling write retries (`auto_retry` must be `false`). |
| Write failure that is not a definite 4xx rejection | Reported as `write_outcome_unknown_not_retried`: the effect may have committed. |
| Identical write requested again after a success | Not executed; the saved result is replayed (`attempts: 0`, `replayed: true`). |
| Identical write requested again after an unknown outcome | Refused with the same unknown-outcome code; the model is told to verify with a read. |
| Model call, provider code in `model.retry_provider_codes` | Retried inside the same retry budget. Authentication and malformed-response errors are not. |
| Retry budget or elapsed-time budget cannot fit another attempt | The original failure is surfaced. Running out of retries does not by itself end the run. |

A retried attempt is not a new logical tool call, so `limits.max_tool_calls` is unchanged by retries. Retry counts are recorded in
the run budget (`budget.retries`), per call (`tool_records[].attempts`) and in `result.recovery` (events, suppressed duplicates,
unknown-outcome writes, total backoff).

`propose_record_update` is classified as read-like because it commits nothing (it returns `committed: false`). Every registered tool
must have exactly one class; the loader fails otherwise.

## Retry budgets

The OpenAI budget (`configs/budget.yaml`, protocol-registered) keeps `max_retries: 1`. The free hosted/local budgets
(`budget-local`, `budget-gemini-free`, `budget-nvidia-free`) use 3 because free endpoints return frequent transient 429/503 responses.
The retry budget lives only in those files.

## Evidence

- `tests/recovery/` (all counted in `reports/tb025-recovery-tests.xml`): classification, backoff determinism and bounds, budget bounds for tools and models, write rules,
  duplicate suppression, timeouts, abort during backoff, runner integration, and integration against the real tool service with
  HTTP-level fault injection (`faulty-fetch.ts`, rules in `fault-schedules.json`). A negative control shows that a naive
  retry-everything loop duplicates a write when its response is lost; recovery does not.
- `scripts/verify-recovery.mjs` writes `evidence/tb025-recovery-report.json`: seeded fault injection, with and without recovery,
  swept over retry budgets. Every figure is computed from the run; see the report for success rates, duplicates (0), retries used
  (never above budget), extra attempts and backoff.
- Mutation check: seven deliberate breakages of `recovery.ts` (budget off-by-one, writes retried, duplicate suppression removed,
  hard cap treated as transient, attempt cap ignored, retries not counted) are each caught by at least one test, except one
  redundant guard that is equivalent by construction.

## Trade-off and limits

Retries raise read success but add attempts (load) and backoff latency; the report shows both. Total success is capped by the
write-response-loss rate because lost writes are deliberately not retried. Faults are synthetic and the model is scripted, so LLM
behavior after a failed or unknown-outcome call is not measured here. Durable restart handling is TB-026.
