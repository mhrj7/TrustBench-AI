# External-agent integration contract: goose 1.55.0 (TB-056)

Contract version 1.0.0. The adapter built in TB-057 (`src/external/`) must implement exactly this; a change needs a new
contract version, recorded before any run that uses it. The threats each rule answers are in
`docs/external/threat-model.md` (entry points EX-01 to EX-24).

## Process model

One episode runs as four processes, all started and stopped by the TrustBench harness:

1. **Tool backend:** the episode's tool service, as for the built-in agents. Baseline arm: the permissive `src.tools.app`
   on loopback. Defended arm: `src.gateway.app` in front of the same backend (`configs/baseline.yaml`,
   `configs/defended.yaml`).
2. **TrustBench MCP adapter:** an MCP server over streamable HTTP on `127.0.0.1` with a random port, started by the
   harness. It holds the episode's gateway session token (defended arm) and forwards each tool call. goose connects to it
   by URL (`--with-streamable-http-extension`); goose does not launch it, so the token never enters goose's process,
   environment or command line (EX-10, EX-23).
3. **Model proxy:** an OpenAI-compatible pass-through on `127.0.0.1` that holds the real provider key, forwards to the
   configured provider and records the system-prompt hash, model identity, usage and any compaction request (EX-02,
   EX-18, EX-22, EX-23). goose is given the proxy's address and a placeholder key.
4. **goose:** the pinned binary, run headless with the invocation below, in a fresh sandbox.

The adapter and proxy are TrustBench code (trusted). goose and everything it emits are untrusted.

## goose invocation (identical in both arms)

Working folder: a new empty folder with a neutral path (no machine path, outside any repository). `HOME`: a new empty
folder. Both are deleted after the episode.

```sh
goose run --no-session --no-profile \
  --provider openai --model <registered model id> \
  --with-streamable-http-extension http://127.0.0.1:<adapter port>/mcp \
  --max-turns <run limit> --max-tool-repetitions <run limit> \
  -q --output-format json -t "<task user text>"
```

Environment: an allowlist, nothing inherited from the harness shell.

| Variable | Value | Why |
| --- | --- | --- |
| `HOME` | the episode's empty home folder | No global hints, skills, plugins, config or sessions (EX-03, EX-05, EX-07, EX-19) |
| `PATH` | system directories only | No project tools reachable by name |
| `CONTEXT_FILE_NAMES` | `[]` | No `AGENTS.md` or `.goosehints` in the prompt (EX-03, observed) |
| `GOOSE_DISABLE_SESSION_NAMING` | `true` | One model request per turn (EX-15, observed) |
| `GOOSE_MODE` | `auto` | No interactive approval prompts; approvals are TrustBench's (EX-17) |
| `GOOSE_DISABLE_KEYRING` | `1` | No keychain access (EX-19) |
| `GOOSE_TELEMETRY_ENABLED` | `false` | No usage data (EX-22) |
| `GOOSE_TEMPERATURE` | the run's registered temperature | Same generation settings as the built-in agents; goose sends none otherwise (observed) |
| `GOOSE_MAX_TOKENS`, `GOOSE_SUBAGENT_MAX_TURNS`, `GOOSE_AUTO_COMPACT_THRESHOLD` | the run's registered limits | Bounded execution, identical across arms (EX-16, EX-18) |
| `OPENAI_HOST`, `OPENAI_BASE_PATH`, `OPENAI_API_KEY` | the model proxy's address and a placeholder | The real provider key stays in the proxy (EX-23) |

Never set: `GOOSE_MOIM_MESSAGE_TEXT`, `GOOSE_MOIM_MESSAGE_FILE`, `GOOSE_RECIPE_PATH`, `GOOSE_RECIPE_GITHUB_REPO`,
`GOOSE_ALLOWLIST`, `GOOSE_TOOLSHIM*`, `SECURITY_PROMPT_*`, and any TrustBench secret or token (EX-04, EX-09, EX-17, EX-20,
EX-21). The harness starts goose with a constructed environment, so these cannot leak in from the shell.

## Tool surface

- **Names:** the adapter's MCP server is named `trustbench`; it exposes every tool in
  `src/policy/capability-manifests.json` `argument_schemas`, the same list both built-in arms give the model
  (`src/arms/arms.ts`). goose shows them to the model as `trustbench__<tool>`; the adapter and the trace use the
  TrustBench name without the prefix.
- **Argument schemas:** copied verbatim from `argument_schemas` (strict: no extra fields, ID patterns, length limits).
- **Descriptions:** copied verbatim from `configs/tool-descriptions.json`, identical in both arms.
- **Nothing else:** no resources, prompts, sampling, elicitation or roots requests from the adapter (EX-13).
- **The model also sees** goose's built-in `load_skill` (EX-06); it reaches no TrustBench tool.

## Calls and results

| goose sends | The adapter does | goose receives |
| --- | --- | --- |
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
| `run_started` | adapter | Provider and model as recorded by the proxy; `prompt_sha256` of goose's system prompt (from the proxy); evaluator version; configuration hash covering the pinned goose artifact checksum, the invocation and the environment above; all limits |
| `model_usage` | model proxy | One per model request: tokens and timing |
| `tool_call_proposed` | adapter | Every `tools/call` received, with the canonical argument hash |
| `policy_decision` | adapter, from the gateway response and audit | `allow`, `deny` with the code, or approval required |
| `tool_call_started`, `tool_call_finished` | adapter | Only after an allow; the outcome and status |
| `run_finished` | adapter | goose's exit status, turns, the final text from `--output-format json`, and the terminal reason (`completed`, `max_turns`, `timeout`, `error`) |

goose's own logs are not trace evidence; they may be kept beside the trace for debugging. No token, key or credential-shaped
value is ever written (TB-004 secret rules).

## Limits

| Limit | Set through | Enforced by |
| --- | --- | --- |
| Turns | `--max-turns` and `GOOSE_MAX_TURNS` | goose, and the harness counting proxied model calls |
| Identical repeated calls | `--max-tool-repetitions` | goose |
| Tokens per response | `GOOSE_MAX_TOKENS` | goose, and the proxy's budget |
| Model calls, tokens, cost per run | the run's budget file | the model proxy refuses requests past the budget; the run ends `budget_exhausted` |
| Wall clock | the run's time limit | the harness kills goose and records `timeout` |

## Acceptance tests TB-057 and TB-058 must add

1. Every listed tool is callable from goose in both arms, and the trace validates against TB-004.
2. Gateway denials reach goose with the exact codes above; a tool outside the list never reaches the backend.
3. The gateway session token and the provider key never appear in goose's environment, command line, prompt, tool schemas
   or saved output (scan every captured artifact).
4. With the invocation above, the model is offered only the `trustbench` tools and `load_skill`, and no project context
   file reaches the prompt (repeat the TB-056 observation inside the harness).
5. goose cannot reach the tool backend, the gateway or the network except through the adapter and the model proxy
   (a deliberately planted direct request fails).
6. Paired runs differ only in the tool backend the adapter forwards to (configuration hashes compared).
