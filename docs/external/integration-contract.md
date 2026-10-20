# External-agent integration contract: goose 1.55.0 (TB-056)

Contract version 1.2.0 (1.0.0 was written in TB-056; the changes made in TB-057 are listed in
[Changes in 1.1.0](#changes-in-110), those made in TB-058 in [Changes in 1.2.0](#changes-in-120)). The adapter (`src/external/`) implements exactly this; a change needs a new contract
version, recorded before any run that uses it. Every report records the contract version it ran under. The threats each rule answers are in
`docs/external/threat-model.md` (entry points EX-01 to EX-24).

## Process model

One episode runs as five processes, all started and stopped by the TrustBench harness:

1. **Tool backend:** the episode's tool service, as for the built-in agents. Baseline arm: the permissive `src.tools.app`
   on loopback. Defended arm: `src.gateway.app` in front of the same backend (`configs/baseline.yaml`,
   `configs/defended.yaml`).
2. **TrustBench MCP adapter:** an MCP server in the harness process, listening on a per-episode local socket. It holds
   the episode's gateway session token (defended arm) and forwards each tool call (EX-10, EX-23).
3. **`trustbench` relay:** a small stdio MCP relay that goose launches as its only extension
   (`--with-extension "<path>/trustbench --socket <socket path>"`). It copies MCP messages between goose and the adapter's
   socket and holds no token, key or configuration of its own, so nothing secret enters goose's process, environment,
   command line or children. A stdio command is used, not goose's HTTP extension, because goose prefixes tool names with
   the command's name for stdio extensions (`trustbench__<tool>`, the same in every episode and arm) but with the URL's
   host, port and path for HTTP extensions, which would change the tool names with every port (observed:
   `evidence/tb056-goose-observations/observations.json`, `contract_checks`).
4. **Model proxy:** an OpenAI-compatible pass-through on `127.0.0.1` that holds the real provider key, forwards to the
   configured provider and records the system-prompt hash, model identity, usage and any compaction request (EX-02,
   EX-18, EX-22, EX-23). goose is given the proxy's address and a placeholder key.
5. **goose:** the pinned binary, run headless with the invocation below, in a fresh sandbox.

The adapter, relay and proxy are TrustBench code (trusted). goose and everything it emits are untrusted.

## goose invocation (identical in both arms)

Working folder: a new empty folder with a neutral path (no machine path, outside any repository). `HOME`: a new empty
folder. Both are deleted after the episode.

```sh
goose run --no-session --no-profile -q --output-format json \
  --provider openai --model <registered model id> \
  --with-extension "<relay path>/trustbench --node <node path> --socket <episode socket>" \
  --max-turns <run limit> --max-tool-repetitions <run limit> \
  --system "<the arm's TrustBench system prompt>" -t "<task user text>"
```

`--system` adds the same TrustBench system prompt the built-in agents get, identical in both arms; goose appends it to its
own built-in prompt (EX-02). goose has no seed setting, so no seed is sent to the model and the trace records `seed: null`.

Environment: an allowlist, nothing inherited from the harness shell (goose is started as `env -i <allowlisted variables>
goose ...`; observed to run normally that way).

| Variable | Value | Why |
| --- | --- | --- |
| `HOME` | the episode's empty home folder | No global hints, skills, plugins, config or sessions (EX-03, EX-05, EX-07, EX-19) |
| `PATH` | system directories only | No project tools reachable by name |
| `CONTEXT_FILE_NAMES` | `[]` | No `AGENTS.md` or `.goosehints` in the prompt (EX-03, observed) |
| `GOOSE_DISABLE_SESSION_NAMING` | `true` | One model request per turn (EX-15, observed) |
| `GOOSE_MODE` | `auto` | No interactive approval prompts; approvals are TrustBench's (EX-17) |
| `GOOSE_DISABLE_KEYRING` | `1` | No keychain access (EX-19) |
| `GOOSE_TELEMETRY_ENABLED` | `false` | No usage data (EX-22) |
| `GOOSE_TEMPERATURE` | the run's registered temperature | Same generation settings as the built-in agents; goose sends none otherwise, and sends this value when set (both observed) |
| `GOOSE_MAX_TOKENS`, `GOOSE_MAX_TURNS` | the run's registered limits | Bounded execution, identical across arms |
| `GOOSE_SUBAGENT_MAX_TURNS`, `GOOSE_AUTO_COMPACT_THRESHOLD` | not set: goose's defaults, identical across arms | Summon is not offered (EX-16); compaction requests go through the proxy and are recorded like any request (EX-18) |
| `OPENAI_HOST`, `OPENAI_BASE_PATH`, `OPENAI_API_KEY` | the model proxy's address and a placeholder | The real provider key stays in the proxy (EX-23) |

Never set: `GOOSE_MOIM_MESSAGE_TEXT`, `GOOSE_MOIM_MESSAGE_FILE`, `GOOSE_RECIPE_PATH`, `GOOSE_RECIPE_GITHUB_REPO`,
`GOOSE_ALLOWLIST`, `GOOSE_TOOLSHIM*`, `SECURITY_PROMPT_*`, and any TrustBench secret or token (EX-04, EX-09, EX-17, EX-20,
EX-21). The harness starts goose with a constructed environment, so these cannot leak in from the shell.

## Tool surface

- **Names:** the adapter exposes every tool in `src/policy/capability-manifests.json` `argument_schemas`, the same list
  both built-in arms give the model (`src/arms/arms.ts`). Because goose launches the relay as the command `trustbench`,
  the model sees them as `trustbench__<tool>` (observed); the adapter and the trace use the TrustBench name without the
  prefix.
- **Argument schemas:** copied verbatim from `argument_schemas` (strict: no extra fields, ID patterns, length limits).
- **Descriptions:** copied verbatim from `configs/tool-descriptions.json`, identical in both arms.
- **Nothing else:** no resources, prompts, sampling, elicitation or roots requests from the adapter (EX-13).
- **The model also sees** goose's built-in `load_skill` (EX-06); it reaches no TrustBench tool.

## Calls and results

| goose sends | The adapter does | goose receives |
| --- | --- | --- |
| `server/discover` (goose's first message) | Answers method not supported; goose falls back to `initialize` (observed) | an error |
| `tools/call` for a listed tool | Strips the prefix, sends `POST /v1/episodes/<episode>/tools/<tool>` with the arguments unchanged; in the defended arm adds `Authorization: Bearer <session token>` | — |
| — | Backend or gateway returns 2xx | `isError: false`; the response body as JSON text, unchanged (the defended arm's provenance envelope included) |
| — | Gateway denies (403) | `isError: true`; `{"detail": "<code>"}` with the gateway's code unchanged: `tool_not_allowed`, `argument_scope_denied`, `resource_denied`, `operation_denied`, `citation_denied`, `required_content_missing`, `directive_attributed_flow`, `tool_filtered`, `counterfactual_write_match`, `masked_rerun_match`, `camel_policy_denied`, `missing_or_invalid_session`, `episode_mismatch`, `stale_capability` |
| — | Approval required (409) | The adapter runs the same approval step as the built-in defended arm (`src/policy/approved_call.py`) and returns its outcome; goose never sees or issues an approval |
| — | Schema or validation error (4xx) | `isError: true`; the backend's `detail` unchanged |
| — | Backend unreachable, timeout or 5xx | `isError: true`; `{"detail": "tool_unavailable"}`; recorded as a tool failure, never as success |
| A tool not in the list | Refused by the adapter without a backend call; recorded as a proposal with decision `deny` | `isError: true`; `{"detail": "tool_not_allowed"}` |

Retries: the adapter never retries a write on its own; repeated calls are goose's, and idempotency is enforced by the
gateway and the tool service exactly as for the built-in agents.

## Trace (TB-004)

The adapter and the model proxy together write one trace per episode that validates against `schemas/trace.ts`:

| Event | Written by | Content |
| --- | --- | --- |
| `run_started` | adapter | Provider and model; `prompt_sha256` of the canonical TrustBench `{system, user}` prompt (the same definition as the built-in agents, so arms and agents compare); `seed: null`; evaluator version; configuration hash covering the pinned binary checksum, the contract version, the invocation and the environment above, the tool list and the model; all limits. goose's full system prompt, as the proxy saw it, is hashed per run in the report (`external.system_prompt_sha256`) |
| `model_usage` | model proxy | One per model request: tokens and timing |
| `tool_call_proposed` | adapter | Every `tools/call` received, with the canonical argument hash |
| `policy_decision` | adapter, from the arm's tool path | Baseline: `allow` with `no_policy` (`baseline.permissive`). Defended: `deny` with the gateway's code, or `allow` (`approval_granted` after the approval step). Unknown tool: `deny` `tool_not_allowed`, decided by the adapter |
| `tool_call_started`, `tool_call_finished` | adapter | Only after an allow; the outcome and status |
| `run_finished` | adapter | The TB-004 outcome, elapsed time, model and tool call counts and tokens. goose's exit status, its JSON `status`, the tools it advertised, the protocol methods and its final text are kept in the report's `external` block and `final_text` |

**Fail closed (TB-002, trace boundary):** the adapter writes `tool_call_proposed` before it forwards a call; if that
write fails, the call is refused with `{"detail": "tool_unavailable"}` and never forwarded. In the TrustBench-tools mode the
gateway itself decides during the forwarded request (it is the enforcement point and keeps its own audit log), so the
adapter writes `policy_decision` from the gateway's answer, followed by `tool_call_started` and `tool_call_finished` for an
allowed call. After any failed write the recorder refuses every later call, so the run cannot continue without evidence.
In the native-integration mode the gateway is TrustBench's MCP proxy and writes `tool_call_proposed` and
`policy_decision` before it forwards anything ([native-integration.md](native-integration.md)).

goose's `--output-format json` result (observed: the messages, the tools advertised to the model, token counts and a
final `status`) is read for `run_finished`; goose's own logs are not trace evidence and may only be kept beside the trace
for debugging. No token, key or credential-shaped value is ever written (TB-004 secret rules).

## Limits

| Limit | Set through | Enforced by |
| --- | --- | --- |
| Turns | `--max-turns` and `GOOSE_MAX_TURNS` | goose, and the harness counting proxied model calls |
| Identical repeated calls | `--max-tool-repetitions` | goose |
| Tokens per response | `GOOSE_MAX_TOKENS` | goose, and the proxy's budget |
| Model calls, tokens, cost per run | the run's budget file | the model proxy refuses requests past the budget; the run ends `budget_exhausted` |
| Wall clock | the run's time limit | the harness kills goose and records `timeout` |

## Acceptance tests

1. Every listed tool is callable from goose in both arms, and the trace validates against TB-004.
2. Gateway denials reach goose with the exact codes above; a tool outside the list never reaches the backend.
3. The gateway session token and the provider key never appear in goose's environment, command line, prompt, tool schemas
   or saved output (scan every captured artifact).
4. With the invocation above, the model is offered only the `trustbench__` tools and `load_skill`, and no project context
   file reaches the prompt (repeat the TB-056 observation inside the harness), and none of the never-set variables
   is present in goose's environment.
5. A trace write failure makes the adapter refuse the call and every later one (fail closed).
6. goose cannot reach the tool backend, the gateway or the network except through the adapter and the model proxy
   (a deliberately planted direct request fails).
7. Paired runs differ only in the tool backend the adapter forwards to (configuration hashes compared).

Where each test lives:

| Test | Where | Status |
| --- | --- | --- |
| 1 | `tests/external/adapter/goose-adapter.test.ts` (real goose calls all ten tools); `scripts/check-external-paired-report.py` over every paired report | TB-057, passing |
| 2 | Adapter unit test (codes mapped unchanged, unknown tool never reaches the registry); the paired-report check (every denial in every trace carries a contract code) | TB-057, passing |
| 3 | The paired-report check scans every output file for credential-shaped values and the provider keys in its environment; the goose test checks the environment goose gets is exactly the allowlist | TB-057, passing |
| 4 | The goose test plants `AGENTS.md` and `.goosehints` in the working folder and checks they never reach the model, checks the offered tools, and checks that no never-set variable is present | TB-057, passing |
| 5 | Adapter unit test: a failing trace write refuses that call and every later one | TB-057, passing |
| 6 | Network confinement and bypass tests | TB-058 |
| 7 | The paired-report check compares the configuration and system-prompt hashes of both arms of every pair | TB-057, passing |

## Changes in 1.1.0

Found while building the adapter (TB-057); every run in TB-057's evidence used 1.1.0.

- The invocation adds `--system` (the TrustBench system prompt, the same in both arms) and the relay's `--node` argument.
- `prompt_sha256` hashes the TrustBench `{system, user}` prompt, as for the built-in agents. goose's full system prompt is
  hashed per run in the report instead.
- In the TrustBench-tools mode, `policy_decision` is written from the gateway's answer, after the proposal, because the
  gateway decides during the forwarded request. The fail-closed rule is restated above.
- `run_finished` carries the TB-004 fields; goose's own status and final text moved to the report.
- goose opens with `server/discover`, which the adapter answers as unsupported.
- `GOOSE_MAX_TURNS` is set; `GOOSE_SUBAGENT_MAX_TURNS` and `GOOSE_AUTO_COMPACT_THRESHOLD` are left at goose's defaults,
  the same in both arms.
- No seed is sent; goose has no seed setting.

## Changes in 1.2.0

Made in TB-058 (in progress). TB-057's evidence ran under 1.1.0.

- **Sandbox.** goose and every process it starts run inside an OS sandbox (`src/external/sandbox.ts`, configured in
  `configs/external-agents.yaml` `sandbox`): `sandbox-exec` on macOS, Landlock on Linux
  (`src/external/bin/landlock-exec.py`, unprivileged, so it also works in the service container).
  - Network: only the episode's adapter socket and the model proxy port can be reached.
  - Files: writes are allowed only inside the episode folder. The harness's files cannot be read: the repository, the
    tool databases, session files, keys, the user's home folder and other episodes.
  - If the platform cannot confine goose, goose refuses to start. The report records the confinement used per run.
- **`TMPDIR`** is set to a folder inside the episode sandbox and is added to the allowlisted environment.
- **One client per socket.** Each episode's adapter or gateway socket accepts only its first client (the agent's relay).
  Later connections are closed without an answer.
- **Cancellation.** Once the episode is cancelled or has ended, the adapter refuses every call with `episode_cancelled`,
  recorded as a `deny` in the trace, and forwards nothing.
- **Native-mode data.** The native integration's synthetic data lives in a service folder outside the agent's sandbox, so
  the agent reaches it only through the gateway.

Not yet demonstrated: the bypass tests that would show these controls hold against deliberate attempts (TB-058
acceptance). Until they pass, no claim says goose cannot reach a tool except through the adapter or gateway.

