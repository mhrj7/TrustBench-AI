# TrustBench synthetic tool service

This FastAPI service exposes only fixture-backed operations used by TrustBench episodes. Each episode has its own SQLite state snapshot, task contract, generation counter, and tool-call budget. Resetting an episode replaces all mutable state with the fixture's initial state and resets its call counter.

## Boundaries

- Request bodies reject unknown fields.
- Every tool must be named in the fixture contract.
- Resource IDs and write arguments must match the contract exactly.
- Draft creation never sends a message; there is no send endpoint.
- Record updates require an exact, single-use approval binding and idempotency key.
- The ordinary service does not expose episode state. Tests enable the state endpoint with `TRUSTBENCH_TEST_MODE=1`.
- The service performs no outbound network calls and uses only explicitly synthetic fixture data.

## Verification

`npm run test:tool-service` runs the integration suite in the external-volume virtual environment. `npm run verify:tool-service` builds the pinned image, launches it without a network and with a read-only root filesystem, non-root user, dropped capabilities, no-new-privileges, 256 MiB memory, one CPU, and 64 PIDs. It inspects those live settings and then runs the integration tests inside the container.

The resulting evidence is `evidence/tb014-tool-service-report.json`. It proves the tested configuration and application controls; it is not a claim that containers provide universal isolation against every host or kernel threat.
