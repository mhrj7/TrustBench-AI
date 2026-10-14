# Run and trace contract

## Purpose

The trace is the evidence record for one TrustBench execution. It reconstructs which configuration ran, which tool calls the model proposed, how policy handled each proposal, which calls actually executed, their outcomes, how the evaluator judged the final state, and how the run ended.

The executable schema is `schemas/trace.ts`; `fixtures/traces/valid-run.jsonl` is the valid round-trip fixture. This document does not override the executable contract.

## Required run identity

Every event contains `schema_version`, `run_id`, `task_id`, a zero-based contiguous `sequence`, and an offset-aware `timestamp`. The first `run_started` event also records provider, model name and revision, prompt SHA-256, seed or explicit `null`, evaluator version, configuration SHA-256, and all run limits.

## Event lifecycle

1. `run_started`
2. Zero or more `model_usage` events
3. `tool_call_proposed` for every proposal
4. `policy_decision` for every proposal considered for execution
5. `tool_call_started` only after an `allow`
6. Exactly one `tool_call_finished` for every started call
7. Zero or more `evaluator_result` events
8. Exactly one final `run_finished`

A denied or approval-pending proposal cannot start. Approval issuance and consumption will be added with the approval service; until then, `require_approval` cannot result in execution.

## Reconstruction and rejection rules

Each proposal and start records a canonical SHA-256 of its arguments. A start must match the authorized proposal's call ID, tool name, arguments, and hash. A finish must match its start's call and span IDs. The final executed-call count must equal the number reconstructed from complete start/finish pairs.

The validator rejects malformed JSON, unknown fields, missing or out-of-order lifecycle events, sequence gaps, changed run/task identity, backwards timestamps, argument tampering, execution without an allow, duplicate or incomplete spans, inconsistent finish states, incorrect executed-call counts, forbidden secret-bearing keys, and credential-shaped strings. Rejected traces are evaluation errors and cannot be counted as safe or successful runs.

## Secret handling

API keys, authorization headers, cookies, passwords, private keys, secrets, and access or refresh tokens are forbidden in traces. Tools emit bounded summaries and opaque state-change IDs rather than raw sensitive results. Synthetic arguments are retained in this fixture to verify exact reconstruction. Later sensitive fixtures must redact values before trace construction while retaining an authorized canonical hash in the protected decision path.

## Versioning

Schema changes require a new `schema_version`, updated fixtures, migration or explicit incompatibility handling, and rerunning all positive and negative tests. Old traces are never silently interpreted under an incompatible schema.

## TB-004 acceptance evidence

- `schemas/trace.ts` rejects structurally invalid and cross-event-invalid traces.
- `fixtures/traces/valid-run.jsonl` round-trips without information loss.
- `reconstructExecutedToolCalls` reconstructs both executed calls in order with arguments and outcomes.
- Tests cover invalid shapes, sequence gaps, execution after denial, orphan completion, argument tampering, secret-bearing fields, credential-shaped values, and incorrect run summaries.
