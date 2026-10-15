# Provenance-aware flow check (candidate defense, 2026-10-15)

> **Status (A-012): ablation, not the default.** In live runs the blocking rule false-blocked a code-shaped value (`BC-4410`)
> that a benign document task legitimately extracts, because rule (b) cannot tell an instruction-carried token from data the
> user asked for. The default gateway variant is `capability_only` again; blocking is kept as `gateway_flow_block` for
> comparison. Its redesign, `directive_flow` (below), keeps the provenance attribution but decides with an isolated classifier
> whether the source sentence is an instruction.

## The gap it addresses

The TB-021 capability policy pins *control* arguments (recipients, record IDs, draft IDs, subjects, idempotency keys) to the
trusted task contract. *Data* arguments (a research-note answer, an email body) cannot be pinned because the agent must write
them. Injected content can therefore ride inside an otherwise authorized write: in the scripted case
`email-attack-marker-body` the capability-only gateway lets an injected marker into the body of a correctly addressed draft
(`tests/arms.test.ts`, ablation test). The provenance labels from TB-020 were recorded but never used for decisions.

## The rule (configs/policy.yaml `provenance_flow`)

For each write tool's registered data arguments, the gateway denies the call when a token in the argument
(a) is a resource identifier present in the episode state that the trusted contract does not authorize, or
(b) matches a registered marker/address pattern (uppercase marker, e-mail address, URI), was **first seen in a tool output
labelled `untrusted`/`unknown` during this session**, and does not occur in the trusted contract.
Ordinary prose, numbers, dates and values extracted from documents are not matched. Off: `--defended-variant capability_only`.

## How it relates to existing work (no novelty claim yet)

- It is a lightweight, token-level form of **information-flow / taint tracking**, the idea behind CaMeL (Debenedetti et al.,
  "Defeating Prompt Injections by Design", source TB-S2), which separates control and data flow with a privileged/quarantined
  model split and capability metadata on values. This check does not quarantine model reasoning and tracks only identifier-
  and marker-shaped tokens, so it is weaker in coverage but needs no second model and no program rewriting.
- Prompt-level and detection defenses (spotlighting, sandwich, tool_filter, MELON) are implemented as registered baselines in
  `configs/defenses.yaml` and compared live in `docs/defense-comparison.md`.
- What would make a claim: a measured reduction in attacker-goal rate over the capability-only gateway with no significant
  rise in benign false blocks, on attacks and tasks not used to design the rule, with a held-out evaluation. The current
  evidence is development-split only and the patterns were designed after seeing the marker attack, so it is a candidate.

## Known blind spots

Semantic manipulation in free text (a wrong answer, persuasive wording) carries no identifier or marker and is not caught.
An attacker who avoids marker-shaped tokens evades rule (b). Exact-string matching misses paraphrased or re-encoded tokens.

## Redesign: directive-attributed flow (`gateway_directive_flow`, `src/agent/defenses.ts`)

1. Salient tokens (registered patterns) and word n-grams in a write's data arguments that do not occur in the trusted task are
   attributed to the sentences of tool outputs whose signature-verified provenance is `untrusted` or `unknown`.
2. Only those sentences go to one classifier call, which never sees the user task and labels each sentence as an instruction or
   as information.
3. The write is denied only when its content traces back to an instruction. A value extracted from a document (BC-4410) traces
   to an informational sentence and is allowed; an injected answer or link traces to an imperative sentence and is denied.

Every decision is logged (`defense.classifications` in the report). It is a candidate designed on the development split
(A-012), and its live results are generated in `docs/defense-comparison.md`. In the first live comparison the audit trail shows
the BC-4410 sentence labeled as information in every benign run (write allowed) and the injected answer and link sentences
labeled as instructions (write denied). After a denial the agent did not always recover the correct answer, so utility under
attack can stay low even when the attacker goal is blocked.

Blind spot, now measured: an injection written purely as a statement of fact is labeled information and passes. The stress
fixture `TB-ATT-DOC-005` (A-013) states the false value as a finance-office notice with no instruction; the live stress section
of `docs/defense-comparison.md` shows `directive_flow` stopping the imperative version but not this one. It is not a tuning
gap: when the authorized document itself carries the false correction, neither provenance nor phrasing separates it from a
genuine correction. Only checking the value against an independent trusted source could, and this harness has none. A classifier error in either direction passes through. Each
attributed write costs one extra model call.
