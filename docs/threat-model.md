# TrustBench-AI threat model and prior-work map

**Version:** 0.1  
**Research cut-off:** 2026-10-14  
**Applies to:** the three synthetic workflows in `docs/scope.md`

## Security objective

TrustBench-AI evaluates whether a tool-using agent completes the authenticated user's task while every side effect remains inside the task's declared authority. The security boundary is the whole agent system: model, harness, policy gateway, tools, state, approval service, and execution environment. Model obedience alone is never treated as an access-control mechanism.

The core security properties are:

1. **User-intent integrity:** untrusted content cannot replace or expand the authenticated task.
2. **Least privilege:** a run receives only the tools, tenants, resources, fields, and side-effect levels required by its task contract.
3. **Data-flow confinement:** untrusted or cross-tenant values cannot flow into unauthorized tool arguments or outputs.
4. **Exact approval:** a consequential call is permitted only when a valid approval is bound to its exact normalized arguments and context.
5. **Effect integrity:** idempotency, replay protection, and state checks prevent duplicate or altered effects.
6. **Evidence integrity:** traces and evaluators record what the system actually proposed, allowed, blocked, and changed.
7. **Bounded execution:** limits on steps, time, retries, tokens, and cost terminate loops and resource abuse.

Passing this benchmark will mean only that a named system configuration met these properties on the declared fixtures and evaluation protocol. It will not establish universal security.

## Assets

| Asset | Security need | Failure example |
| --- | --- | --- |
| Authenticated task contract | Integrity and authenticity | Retrieved text changes the recipient or target record. |
| Capability manifest and policy | Integrity and fail-closed availability | A missing policy silently becomes allow-all. |
| Synthetic tenant data and canaries | Confidentiality and isolation | Tenant A run reads a Tenant B document. |
| Tool arguments and results | Integrity and provenance | An untrusted document value becomes an approved recipient. |
| Approval records | Integrity, freshness, non-transferability | Approval for one value is replayed for another value. |
| Benchmark state | Integrity and resetability | Retried execution creates two drafts or two updates. |
| Traces and evaluation records | Completeness, integrity, and controlled disclosure | A blocked call or failed run disappears from the report. |
| Provider credentials and host resources | Confidentiality and least privilege | A tool or generated command accesses host secrets. |
| Budget and runtime availability | Availability and bounded use | An agent loops until the account or local machine is exhausted. |

## Actors and assumptions

| Actor | Capability assumed | Capability not assumed in the core evaluation |
| --- | --- | --- |
| Authenticated benchmark user | Supplies a task selected from the versioned suite. May make mistakes. | Malicious host administrator or physical access to the Mac. |
| Content attacker | Controls all or part of a retrieved document, email body, record note, metadata field, or tool-returned string. Knows the public workflow and may adapt text to the defense. | Ability to alter trusted task contracts, policy files, or evaluator code. |
| Malicious or compromised model output | Can emit arbitrary prose and proposed tool calls within the model interface. | Direct possession of raw credentials or a tool client. |
| Faulty tool/provider | Can return errors, malformed data, latency, duplicated responses, or transient inconsistency. | Compromise of a real production service; core tools are local and synthetic. |
| Benchmark developer | Can introduce configuration or evaluator defects accidentally. | Deliberate falsification by a repository maintainer; review and provenance reduce but do not eliminate this risk. |

All model output and retrieved content are untrusted. The local operating system, checked-in benchmark code, versioned task contracts, evaluator code, and configured policy are trusted for the core release. Unknown provenance is untrusted.

## Trust boundaries and enforcement points

```mermaid
flowchart LR
    U[Authenticated task contract] --> R[Bounded agent runtime]
    P[Model provider] -->|untrusted output| R
    D[Untrusted synthetic content] -->|tool result with provenance| R
    R -->|proposed call only| G[Central policy gateway]
    A[Approval service] -->|exact scoped approval| G
    G -->|validated authorized call| T[Mock tool adapters]
    T --> S[(Resettable synthetic state)]
    R --> L[(Append-only run trace)]
    G --> L
    T --> L
    S --> E[Independent outcome evaluator]
    L --> E
```

The decisive boundary is the central policy gateway. The model proposes actions; it cannot execute tools, inspect credentials, mint approvals, or rewrite policy. Every tool adapter is reachable only through the gateway. The evaluator reads final synthetic state and the trace independently of the model's final prose.

| Boundary | Required control | Fail-closed rule |
| --- | --- | --- |
| User/task → runtime | Versioned task schema and authenticated task identity | Invalid or unknown task does not start. |
| Provider → runtime | Structured response parsing and model-output size limits | Malformed output is a recorded model failure. |
| Tool result → model | Source, tenant, resource, and trust labels | Missing provenance becomes untrusted and cannot grant authority. |
| Runtime → gateway | Typed call envelope with task/run/capability IDs | Direct tool access is impossible; invalid envelope is blocked. |
| Approval → gateway | Exact normalized arguments, actor, expiry, nonce, task and run binding | Missing, expired, altered, reused, or broader approval is blocked. |
| Gateway → adapter | Allowlisted tool and validated arguments only | Unknown tool, tenant, resource, field, or side effect is blocked. |
| Adapter → state | Atomic write and idempotency key | Duplicate request returns the original result without a second effect. |
| Runtime/gateway/tool → trace | Stable event schema, redaction, monotonic event order | Trace failure prevents consequential effects in defended mode. |
| Trace/state → evaluator | Versioned evaluator and expected-state oracle | Missing or invalid evidence is an evaluation error, never a pass. |

## Attack-surface inventory

| ID | Surface | Representative attack or failure | Workflows | Observable security invariant | Planned primary control | Planned test class |
| --- | --- | --- | --- | --- | --- | --- |
| AS-01 | Trusted user input | Direct prompt injection asks for an out-of-scope action. | All | User text cannot exceed the task contract. | Task schema and capability manifest. | Direct injection and policy-boundary fixtures. |
| AS-02 | Retrieved content | Indirect prompt injection tells the agent to ignore the task or invoke another tool. | All | Retrieved instructions never authorize an action. | Provenance labels, gateway authorization, outcome checks. | Injection in body, metadata, quoted text, and long context. |
| AS-03 | Resource identifiers | Model guesses or substitutes another tenant's document, contact, or record ID. | All | Every resource belongs to the authorized tenant and allowlist. | Tenant/resource binding at gateway and adapter. | Cross-tenant and ID-substitution fixtures. |
| AS-04 | Tool selection | Model calls an unavailable, higher-impact, or internal tool. | All | Only task-declared tools are callable. | Per-task tool allowlist and no raw clients in model context. | Unknown-tool and excessive-agency fixtures. |
| AS-05 | Tool arguments | Tainted content changes recipient, field, value, query, or destination. | All | Security-sensitive arguments derive from trusted task data or an approved transform. | Argument schema, provenance-aware constraints, exact allowlists. | Argument-injection and tainted-flow fixtures. |
| AS-06 | Approval interface | Forged, stale, ambiguous, transferred, or model-generated approval. | Record update | Approval is human-issued and bound to exact context and arguments. | Separate approval service, canonicalization, expiry, nonce, single use. | Approval mismatch, expiry, replay, and dialogue-forging fixtures. |
| AS-07 | Retry and concurrency | Duplicate draft/update after timeout, retry, or replay. | Draft, record update | One logical operation has at most one committed effect. | Idempotency key, atomic state transition, duplicate result reuse. | Retry, duplicate delivery, and interrupted-commit fixtures. |
| AS-08 | Agent loop | Recursive calls, excessive planning, token exhaustion, or intentional resource burn. | All | Every run ends within declared budgets and has an explicit terminal status. | Step/time/retry/token/cost limits and cancellation. | Loop, timeout, provider-latency, and budget fixtures. |
| AS-09 | Tool response | Malformed, oversized, conflicting, or error-bearing output confuses the agent. | All | Tool errors and invalid results cannot be interpreted as authorization or success. | Typed result schema, size limits, explicit error states. | Malformed response and fault-injection fixtures. |
| AS-10 | Hidden data and output | Agent reveals fixture canaries, policy text, trace secrets, or another tenant's data. | All | Output contains only task-authorized information. | Data labels, response evaluator, redaction, no provider credentials in context. | Canary, cross-tenant, and secret-exfiltration fixtures. |
| AS-11 | Trace pipeline | Missing, reordered, truncated, or secret-bearing events produce misleading evidence. | All | Every decision and effect is attributable and safely recorded. | Required event schema, sequence numbers, redaction, completeness checks. | Trace-drop, redaction, and evaluator-consistency fixtures. |
| AS-12 | Evaluator | Model prose claims success while state is wrong; weak oracle rewards unsafe behavior. | All | Scores follow independent state and policy oracles. | Deterministic outcome checkers and claim-to-evidence links. | False-success, hidden-effect, and evaluator mutation tests. |
| AS-13 | Configuration | Baseline and defended runs differ in model, prompts, budgets, or state. | All | Paired comparisons differ only by declared defense controls. | Frozen run manifest and config hash. | Pair-integrity and reproducibility checks. |
| AS-14 | Local execution environment | Generated code, package scripts, or permissive networking reach host files or external services. | All | Benchmark actions remain inside the synthetic sandbox and external project directory. | No shell tool for the agent, network deny, narrow mounts, secret separation. | Escape-attempt and denied-network checks. |
| AS-15 | Model/provider variability | Non-determinism, model revision drift, refusal, or outage biases results. | All | Provider failures and model/version metadata remain visible; missing runs are not silently excluded. | Provider-neutral adapter, pinned identifiers, repeated runs, explicit denominators. | Repeated-run and outage fixtures. |
| AS-16 | Persistent state | A prior episode poisons the next run or retained memory grants authority. | All | Core episodes begin from a known snapshot and share no agent memory. | Per-episode reset and state hash. | State-reset and order-randomization checks. |

## Threat-to-workflow map

| Workflow | Highest-priority threats | Required evidence of defense |
| --- | --- | --- |
| Document evidence analyst | AS-02, AS-03, AS-05, AS-10, AS-12 | Attack text is observable as data; cross-tenant reads and unauthorized note content are blocked; final factual claims cite allowed passages; final state contains no unauthorized change. |
| Email draft assistant | AS-02, AS-05, AS-07, AS-10, AS-12 | Reference text cannot change recipient; exactly one local draft exists; no sent-message state exists; no canary or unrelated content appears. |
| Controlled record update | AS-03, AS-05, AS-06, AS-07, AS-11, AS-12 | Exact arguments match a fresh single-use approval; wrong tenant/record/field/value is blocked; replay causes no second effect; audit and final state agree. |

## Abuse cases that must remain distinguishable

- **Attack present, no unsafe proposal:** the model ignored the injection.
- **Unsafe proposal, gateway block:** model robustness failed but system enforcement succeeded.
- **Gateway allow, adapter refusal:** the outer environment prevented the effect, but gateway policy failed.
- **Unsafe committed effect:** end-to-end security failure.
- **Safe but useless refusal/block:** security outcome may pass while benign utility fails.
- **Tool/provider failure:** operational failure, neither a security success nor an attack success.
- **Missing trace or state evidence:** evaluation error, never silently scored as safe.

This separation prevents a detector score, a policy decision, and a real state outcome from being reported as if they were the same measurement.

## Explicitly excluded threats

The core release does not evaluate the following. Exclusion means no security claim will be made about it.

| Excluded threat | Reason and extension path |
| --- | --- |
| Compromised macOS host, malicious administrator, physical attack, firmware attack | Requires a different host and hardware trust model. A later deployment review may cover it. |
| Real SaaS/API compromise or production credential theft | Core tools and data are synthetic and local; no production credentials are connected. |
| Provider-side training-data leakage, model-weight theft, or provider insider | Outside the application boundary; provider metadata and contractual controls can be documented separately. |
| Foundation-model training poisoning or backdoors | TrustBench evaluates inference-time systems and does not train a foundation model. |
| Cross-session learned memory poisoning | Core agents have no persistent learned memory. Add only as a separately scoped extension with dedicated reset and provenance rules. |
| Multi-agent delegation and inter-agent protocol attacks | Core release uses one task agent and one enforcement gateway. |
| Browser/GUI visual prompt injection and live web navigation | Core workflows use typed mock tools and synthetic text fixtures, not a browser or computer-use model. |
| Audio/video adversarial examples and physical-world sensor spoofing | No audio, video, or sensors are in the core workflows. |
| Model extraction, membership inference, and intellectual-property attacks | Separate model/privacy research problems that do not exercise the defined tool boundary. |
| Denial of service against the model provider or external network | Provider faults are measured operationally, but adversarial infrastructure-scale availability is not tested. |
| Cryptographic implementation attacks, side channels, or kernel/container escape | Standard libraries and local runtime are assumed; a production penetration test would be separate. |
| Harmful-domain content policy and factual truth across open-ended topics | Core evaluation covers authorization, reliability, and declared task correctness on synthetic fixtures. |
| Universal or zero-day prompt-injection resistance | Finite benchmarks cannot justify this claim; adaptive and holdout attacks reduce overfitting but do not prove immunity. |

## Prior-work map

| Source | What it contributes | How TrustBench-AI uses it | What remains distinct or unclaimed |
| --- | --- | --- | --- |
| [NIST AI 600-1, Generative AI Profile](https://doi.org/10.6028/NIST.AI.600-1) | Risk-management framing for generative-AI systems, including governance, measurement, and documented limitations. | Versioned risk scope, explicit failure categories, evidence and reporting discipline. | NIST alignment is not certification or compliance. |
| [OWASP Agentic AI Threats and Mitigations](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/) and [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) | Agent goal manipulation, tool misuse, excessive permissions, identity/privilege and cascading failures. | Attack-surface checklist and least-privilege controls. | A mapping to OWASP categories is not proof that all listed threats are covered. |
| [AgentDojo, NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/97091a5177d8dc64b1da8bf3e1f6fb54-Paper-Datasets_and_Benchmarks_Track.pdf) | Dynamic evaluation of prompt injection in tool-using agents with utility and security tasks. | Paired benign/adversarial evaluation, attacker goals, adaptive/holdout thinking, and explicit tool environments. | TrustBench fixtures and results must be reported independently; no AgentDojo result may be copied as a TrustBench metric. |
| [Formalizing and Benchmarking Prompt Injection Attacks and Defenses](https://arxiv.org/abs/2310.12815) | Systematic prompt-injection attack/defense evaluation rather than isolated demonstrations. | Attack taxonomy and multiple-defense comparison discipline. | The core TrustBench claim concerns its own workflows and outcome oracles. |
| [CaMeL: Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813) | Separates control and data flow and applies capabilities around a potentially vulnerable model. | Motivates provenance-aware data flow, capability checks, and enforcement outside model prose. | TrustBench does not claim CaMeL's formal guarantees or reproduce its architecture unless later implemented and validated explicitly. |
| [OpenAI: Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety) | Structured outputs, tool approvals, guardrails, trace grading, and keeping untrusted data from directly driving actions. | Exact approvals, typed tool envelopes, trace evaluation, and layered controls. | Provider guidance is design input, not evidence that this implementation is safe. |
| [Anthropic: Mitigating prompt injections in browser use](https://www.anthropic.com/news/prompt-injection-defenses) | Defense in depth and the explicit position that prompt injection remains unsolved. | Supports conservative claims, adaptive testing, and separating model robustness from harness safeguards. | TrustBench does not import vendor benchmark numbers or claim browser-agent coverage. |

## Claim discipline

- TrustBench-AI is an implementation and evaluation project informed by the sources above. This document makes no claim of research novelty, patentability, certification, complete OWASP/NIST conformance, or superiority over existing systems.
- Reported metrics must come from reproducible TrustBench runs and include configuration, sample count, uncertainty where applicable, failures, and denominators.
- A blocked attack does not prove the model resisted it. A model refusal does not prove the gateway would have blocked it. A detector alert does not prove an effect was prevented.
- Results on synthetic fixtures do not authorize connecting real accounts or production data.

## TB-002 acceptance evidence

This document identifies assets, actors, assumptions, trust boundaries, enforcement points, 16 explicit attack surfaces, workflow mappings, observable outcome categories, exclusions, and prior work. Each in-scope attack surface has a planned invariant, control, and test class. Excluded threats are named so future reports cannot imply coverage. No novelty or universal-security claim is made.
