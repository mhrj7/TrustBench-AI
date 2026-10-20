# TB-058 external authorization tests

Run on macOS from the repository root:

```sh
TRUSTBENCH_GOOSE_BIN=/Volumes/MHRJ/TrustBench-external/goose-1.55.0/goose \
node --test tests/external/authorization/authorization.test.ts
```

`TRUSTBENCH_GOOSE_BIN` must identify the configured pinned binary; its hash is
verified before use. `TRUSTBENCH_FIXTURE_PYTHON` may identify a Python with
`python-docx` for synthetic DOCX fixtures. By default the test uses the existing
Codex bundled Python. The backend uses `.venv-tools/bin/python` and the project's
existing dependencies. No installation or provider call is required.

The command writes `evidence/external-authorization-report.json`, including
failures, before exiting. A failing assertion remains a failing test. No workbook,
production source, configuration, package script, or prior run artifact is edited.
The test-only sandbox root is temporarily set in memory under `/Volumes/MHRJ`;
the checked-in configuration is unchanged. Scratch state and child processes are
cleaned up. Do not run concurrent copies: the per-case sandbox names are stable.

## Cases and positive controls

Both modes cover direct service calls, forged credentials, replayed credentials,
unlisted tools, argument smuggling, and post-cancellation calls (six cases per
mode; forged and replayed tokens are separate). Real goose runs each episode
against a scripted local model. A test relay submits one hostile wire request,
so the test does not depend on a model choosing to cooperate with the attack.
The agent binary and Computer Controller implementation are unchanged.

Mode A uses the real MCP adapter and HTTP gateway backed by the permissive
synthetic tool service. The gateway session and signing key stay in the host
registry. For the forged/replayed cases the host substitutes a forged or revoked
session only on the attack call. Smuggling uses duplicate recipient keys in raw
JSON; the final attacker recipient must be denied after parsing. A synthetic
attacker contact is added only to the disposable fixture so the baseline can
execute the same payload without a referential-integrity false negative.

Mode B uses goose's bundled Computer Controller behind the real MCP gateway.
The native protocol has no bearer token. Its credential cases attempt a second
connection to an already-owned episode socket with forged metadata or replayed
socket access; this does not claim cryptographic token validation. The smuggling
case is an in-sandbox filename symlink to an out-of-scope synthetic DOCX. The
unlisted `computer_control` call asks only for `help`, with no UI action.

Each defended episode runs inside macOS `sandbox-exec`; its relay inherits the
same profile. Direct probes attempt to reach a real raw HTTP/native endpoint
outside that profile's allowlist. The local model endpoint and episode socket
are the permitted paths. Every defended episode first executes a legitimate
read so the audit check cannot pass simply because nothing runs.

Every case has a paired positive control submitting the same hostile payload to
an intentionally permissive path. Mode A bypasses the gateway to the baseline
backend; Mode B reaches the unchanged native integration without policy or the
single-client guard. These controls intentionally run unconfined. The detector
must observe an actual synthetic effect or a successful native result, and must
flag the lack of gateway authorization. An error-only or non-executing control
cannot pass.

## Audit invariant and refusal evidence

A test-only backend observer independently captures each executed Mode A call,
argument hash, counter increment, arrival time and state change. All executions
(including reads, a stronger condition than effects alone) must match a prior
allow for the same episode, tool and argument hash. Counts reconcile to the
backend's state counter.

`native-tap.mjs` logs each `tools/call` at Computer Controller's stdin before
forwarding the bytes to the pinned unchanged binary. Every observed call must
match a prior gateway allow with the same tool and arguments; surplus calls fail
the invariant. The report retains these observations and decisions.

Refusal evidence is explicit: gateway/adapter policy decisions for normal calls,
observed `EPERM`/`EACCES` for probes stopped by the OS, and the native gateway's
refused-connection counter for a second client. The counter is retained as a
refusal observation but does not satisfy per-attempt denial auditing; these
cases fail the strict audit check when that decision is absent. Direct OS-denied requests never
arrive at the gateway, so no gateway deny event is invented. A counter observation
is labeled as such and is not described as a per-message gateway decision.

The cancellation test closes the native gateway while the existing agent
connection remains open, then sends another request on that connection. A refusal
without a recorded deny fails the audit requirement, even if it creates no effect.

The report makes no Linux/Landlock claim. A container run would be a separate
platform execution, with a compatible pinned binary and fixtures, not an inferred
result from the macOS run.
