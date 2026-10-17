# Tool interception and provenance (TB-019 / TB-020)

The trusted host initializes synthetic state and constructs `Gateway(raw_app)`.
Only `gateway.app` is served. Raw tool routes, reset, state access, and session
issuance are never mounted on the agent-facing listener. The raw ASGI application
runs in-process behind the gateway with no separate port. Never launch
`src.tools.app:app` alongside this defended configuration. Historical TB-014
service tests and the TB-017 pilot remain separate baseline artifacts.

Example host launch, from the repository root:

```
.venv-tools/bin/python -m src.gateway.serve --fixture TB-BEN-DOC-001 --episode demo --session-file .tool-state/gateway-session.json
```

The session file is exclusively created with mode 0600, is gitignored, and must
be read only by trusted host code. Pass its fields to `createGatewayToolRegistry`
in `adapter.ts`; give the resulting registry to the existing bounded runner.
Tool schemas and prompts receive no token, raw transport, database path, backend
URL, or arbitrary shell/file tool. Defended experiment wiring and baseline
parity live in `src/arms` (TB-024); this directory supplies the tested transport boundary.

Every gateway request checks a host-issued session, bound episode and allowed
tool before dispatch. The backend still validates the argument schema and task
contract before effects. Capability expansion/normalization is TB-021. Failed
backend calls remain explicit errors. Revocation blocks subsequent calls, not
already-dispatched calls; in-flight cancellation is later work.

## Provenance

Responses carry versioned typed envelopes with source IDs, trust labels, and
transformation history. Retrieved data and write results remain `untrusted`.
Read/search source IDs identify documents; operation/episode IDs identify all
other results. Empty searches still retain operation lineage. The gateway audit
records the same metadata and the argument hash without the bearer credential.
The agent adapter preserves the complete envelope. Its serialization into model
messages and tool records therefore preserves the labels. Legacy bare payloads
or malformed/unsupported labels become `unknown` with an explicit reason.

Python `transform` unions source IDs and records the named transformation; any
unknown input propagates unknown status. A missing input lineage is unknown.
The Python and TypeScript decoder tests cover lost and forged trust labels.
These labels describe lineage, not cryptographic authenticity or information-flow
security. Free-form model output can mix sources: lineage is unknown unless an
explicit transformation with all inputs is recorded. Do not infer trusted
provenance from model-written citations or payload fields.

## Boundary and limits

Assumes model tools are registered by trusted host code, and the model has no
arbitrary code execution or local-file access. Python/TypeScript object privacy
is not process isolation against a compromised host. A malicious host can access
the store directly; that threat is excluded. The synthetic backend requires no
external network requests. This is a local development boundary, not a claim of
production isolation, durable auditing, or protection against all attacks.

Run `npm run test:gateway` and `npm run test:provenance`. Tests include bypass
attempts, episode/token tampering, revocation, permitted writes, all nine tool
transports, missing labels and serialized/combined lineage.

## Measured contribution of each layer (TB-036)

`docs/ablations.md` (A-027, development data) reports what each layer adds. The tool allowlist with contract-scoped
arguments carries the measured protection; strict schemas alone, exact-argument approval (contract scoping already binds
the exact update arguments), sticky denials and the blocking flow check show no measurable security contribution on those
fixtures, and the blocking flow check costs benign utility. Approval remains in the frozen design as defence in depth;
it is not claimed as an independent protection.
