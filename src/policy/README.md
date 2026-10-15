# Capabilities and approval receipts (TB-021 / TB-022)

The host issues capabilities from the fixture's task contract. A session binds the
user ID, tenant ID, episode ID, reset generation, allowed operations, resources,
recipient, destination record/note and exact consequential arguments. Callers can
request a subset of tools, never a superset. `capability-manifests.json` records
all six task templates and all nine JSON schemas; regenerate using
`scripts/export-capabilities.py`. Live generation bindings come from the store.

All gateway arguments undergo strict schema validation before internal dispatch.
IDs are opaque and compared exactly: no URL decoding, whitespace trimming,
case folding, or Unicode normalization expands access. Unknown operations and
extra fields are denied. Search results remain constrained by the backend's
resource allowlist. No send or external-destination tool is permitted. The store
checks generation and user/tenant scope again inside the write transaction, so
reset races cannot reuse stale capabilities.

## Approval flow

The consequential operation in the current synthetic workflows is
`apply_record_update`. Drafts and notes remain local preparatory artifacts.
An initial request creates a durable pending approval and returns HTTP 409 with
`detail=approval_required` and `request_id`. No tool effect occurs. This is the
pause boundary. `src/policy/workflow.py` wraps it in a LangGraph graph
(`propose` -> `gate` with `interrupt()` -> `execute`) with a durable SQLite checkpointer.
The `gate` node restarts from its top on resume and holds no side effects; `execute`
may be replayed from a checkpoint and returns the saved receipt instead of a second
effect. Host approval (`ApprovalStore.approve`) is the authority: the resume payload
alone cannot make the gateway execute, and changed checkpoint arguments are denied.
Wiring this graph into the full baseline agent is TB-024.

The trusted operator reviews the exact stored arguments and approves locally:

```
.venv-tools/bin/python -m src.policy.approve --request-id REQUEST_ID --user-id USER_ID --ttl 300
```

Use the same `TRUSTBENCH_TOOL_DB` as the gateway. This is a host-only command, not
an agent tool or public approval endpoint. The caller must be the trusted operator;
the user ID scopes the event but is not a substitute for operating-system access
control. Pending records in the SQLite `action_approvals` table store the complete
arguments, owner, operation, idempotency key and generation for inspection.

The operator resumes by submitting the identical request through the gateway.
Approval expiry is at most 300 seconds. Wrong users, modified arguments, reused
keys with different payloads, revoked grants and old episode generations fail.
A consumed receipt cannot be approved again. Revocation cannot undo a committed
action. Expired grants cannot be silently extended; a new workflow must be
explicitly initiated by the host.

Approval consumption, result receipt, tool-call counter, state update and audit
record commit in one SQLite transaction. Concurrent or restarted retries of the
same committed action return its saved result without another effect or quota
increment. A completed receipt remains readable after its grant expiry because
no new action is executed. Errors before commit roll back both state and receipt.
The response is only emitted after commit. Tests include a separate Python
process reopening the same database and concurrent independent connections.

## Limits and evidence

This guarantees atomicity only for the local SQLite-backed synthetic actions.
It makes no exactly-once claim for external email, payments or other remote APIs.
Sessions are intentionally in-memory: after a gateway restart the trusted host
must rebind a session to the same episode without resetting it to resume receipts.
The demo launcher resets a fresh episode; it is not the durable resume entrypoint.
Baseline tool-service calls without gateway context retain their historical
behavior and must never be exposed to the defended agent. The only served
application is the gateway, under the TB-019 host boundary.

Run `npm run test:policy` and `npm run test:approval`. Evidence is in the corresponding
JUnit reports under `reports/`. These are functional/security checks on synthetic
fixtures, not new benchmark attack-success measurements.

## Boundary and normalization tests (TB-023)

`fixtures/policy/invariants.json` declares eight security invariants (default deny,
exact destinations, resource scope, cross user/tenant/episode isolation, approval and
replay, malformed arguments, malformed tool outputs, stale capabilities). Every one
needs at least one positive and one negative test; `tests/policy/conftest.py` aborts
collection if any is missing and writes `reports/policy-invariant-coverage.json`.
Adversarial inputs live in `fixtures/policy/adversarial.json`; Hypothesis property tests
cover arbitrary recipients, Unicode forms and arbitrary JSON arguments. The gateway now
fails closed (HTTP 502 `malformed_tool_output`) on non-JSON, NaN or non-object error
output. Run `npm run test:policy` (report: `reports/policy-tests.xml`).

These are synthetic fixtures and randomized probes: passing them does not prove security
against all attacks, only that the declared invariants hold on the exercised inputs.
