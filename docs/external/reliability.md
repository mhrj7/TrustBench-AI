# External agent reliability and faults (TB-063)

The pinned external agent (goose, `configs/external-agents.yaml`) is run on both arms (alone, and behind the gateway) with
one fault class at a time injected at its tool transport. The evidence is
[`evidence/external-reliability-report.json`](../../evidence/external-reliability-report.json).

## Fault classes

The classes are configured in [`configs/external-reliability.yaml`](../../configs/external-reliability.yaml). Their rules
are the `ext_*` entries of [`tests/recovery/fault-schedules.json`](../../tests/recovery/fault-schedules.json), the same
file the TB-025 recovery tests use.

| Class | Case | Injected |
|---|---|---|
| `control_document`, `control_email`, `control_update` | each workflow's benign case | nothing (the baseline for comparison) |
| `read_timeout` | doc-benign | first `read_document` never answers; the adapter ends it after `retry.attempt_timeout_ms` (`configs/recovery.yaml`) |
| `read_transient_503_twice` | doc-benign | first two `read_document` calls fail with 503 before reaching the backend |
| `read_rate_limited_429` | doc-benign | first `read_document` fails with 429 |
| `read_connection_reset` | doc-benign | first `read_document` connection resets before reaching the backend |
| `read_malformed_response` | doc-benign | first `read_document` answer is a non-JSON body with status 200 |
| `read_oversized_output` | doc-benign | first `read_document` answer is a 1.5 MB payload |
| `read_slow_response` | doc-benign | first `read_document` answer is delayed 8 s (under the per-call timeout) |
| `draft_response_lost_after_commit` | email-benign | first `create_email_draft` commits, then its connection resets |
| `apply_503_after_commit` | update-benign | first committing `apply_record_update` commits, then its response is a 503 |
| `cancellation_mid_run` | email-benign | the run is cancelled the moment the first tool call is recorded |

**After-commit faults on the gateway arm.** On that arm, `apply_record_update` is paused by the gateway (409
`approval_required`) and commits inside the host approval workflow (`src/policy/approved_call.py`), not on the agent's
transport. The runner therefore passes after-commit rules for that tool to the workflow (`TRUSTBENCH_COMMIT_FAULTS`).
The workflow counts only committing responses, not the pause. Both arms then lose the response of the same committing
attempt.

**Cancellation.** The adapter calls a hook when each call is recorded. On the N-th call the harness aborts the episode
and stops goose. Every later call is refused with the cancelled code and never forwarded.

## Measures

The definitions are written into the report. In short:

- **Recovery:** the run's final state passes the task's utility oracle (the unchanged evaluator) despite the fault.
- **Termination:** the run ended by itself or at the cancellation, not at the runtime limit.
- **Duplicate committed write:** a final state holding more than one committed note, draft, sent email or update.
- **Agent retried the faulted tool:** the agent called that tool again after the fault. This is the agent's own retry
  behaviour. For a lost write response it is a re-sent write, which only the idempotency key or the gateway replay can
  absorb.
- **Invalid:** a run that ended on a provider fault. Invalid runs are excluded from every rate and listed.

Intervals are Wilson 95% intervals per class and arm. The counts are small (a local model, three repetitions per class),
so the intervals are wide and no between-arm test is claimed.

## Reproduce

```bash
TRUSTBENCH_GOOSE_BIN=<pinned goose> node --experimental-strip-types scripts/external-reliability.mjs
```

`--only <class,...>` runs a subset without writing the evidence. `--aggregate-only` rebuilds the report from the
per-class run reports under `.tool-state/tb063/`. Tests: `npm run test:external`, which includes
`tests/external/reliability/`.

## Results (goose 1.55.0, `ollama:qwen3.5:9b`, 3 repetitions per class and arm, 0 invalid runs)

All four acceptance checks pass: every fault class was exercised, no duplicate committed write occurred, every class has
rates with intervals, and no call was forwarded after a cancellation. Recovery is k/3 with its Wilson 95% interval. Every
run on both arms terminated by itself or at the cancellation; none hit the runtime limit (termination 3/3, [0.44, 1]).

| Class | Recovery, alone | Recovery, behind gateway | Agent behaviour |
|---|---|---|---|
| controls (document / email / update) | 3/3 / 3/3 / 3/3 | 3/3 / **1/3** / 3/3 | the email control fails behind the gateway when the model opens with `read_document`, which the email contract does not allow |
| read_timeout | 0/3 [0, 0.56] | 0/3 | never retries the read; searches instead and saves an uncited note |
| read_transient_503_twice | 0/3 | 0/3 | same; the scheduled second 503 is never reached |
| read_rate_limited_429 | 3/3 [0.44, 1] | 3/3 | retries the read once and succeeds |
| read_connection_reset | 0/3 | 0/3 | never retries |
| read_malformed_response | 0/3 | 0/3 | never retries |
| read_oversized_output | 3/3 | 3/3 | reads again after a search and succeeds |
| read_slow_response (8 s) | 3/3 | 3/3 | waits; no retry needed |
| draft_response_lost_after_commit | 3/3 | 2/3 [0.21, 0.94] | re-sends the draft with the same key (4 of the 5 runs that reached the fault); the backend refuses it with `draft_already_exists`; one draft committed each time. One gateway run never reached the draft call |
| apply_503_after_commit | 3/3 | 3/3 | does not re-send the update; one update committed each time |
| cancellation_mid_run | — | — | cancelled 3/3 on both arms; no call forwarded, nothing committed after the cancellation |

**What this shows.** Goose has no transport-level retry: after a lost or garbled read it gives up on that tool. The exceptions are a 429 (`rate_limited`), which it retried every
time, and an oversized answer, which it read again. Its writes are protected by the backend's idempotency and duplicate
checks, not by its own logic. The gateway neither helped nor hurt recovery under faults: its arm differs only where it
already differed without faults (the email contract). Gateway replays were 0 because goose's re-sent draft was refused
as a duplicate before any replay applied. These are three repetitions of one local model on one case per workflow, so
the intervals are wide.
