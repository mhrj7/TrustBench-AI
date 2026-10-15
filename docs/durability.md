# Durable runs, sessions and cancellation (TB-026)

- **Run store** (`src/agent/run-store.ts`, SQLite, owner-only file): the runner checkpoints after every model response and
  every tool call, keeps a write-ahead intent log per tool call, honors cancellation markers, and records exactly one final
  outcome per run (a second finisher receives the stored outcome; a finished run never executes again).
- **Resume rules**: an interrupted read is re-executed. An interrupted write is **not** repeated: it is reported as
  `write_interrupted_outcome_unknown` (configs/durability.yaml) because its effect may have committed. Writes that are replay-safe
  through the gateway's approval receipts (`approval_required_tools`) are re-submitted, and the receipt prevents a second effect.
- **Gateway sessions** (`--session-db`, `--resume`): bindings persist with a hash of the bearer token (never the token), the
  signing key and the capability; they expire after `gateway_session_ttl_s` and are purged on start. A reset after a restart still
  invalidates old capabilities.
- **Evidence**: `tests/restart/` kills the real agent process (SIGKILL) during a read, after a committed write, at the approval
  pause (also restarting the gateway), and tests cancellation; `reports/tb026-restart-tests.xml`. Two deliberate breakages
  (no interrupted-write guard; final outcome not persisted) are caught.
- **Limits**: the per-run wall-clock timeout restarts in the resumed process; the flow-check token memory of a restored gateway
  session starts empty; retention is enforced on store open, not by a background job.
