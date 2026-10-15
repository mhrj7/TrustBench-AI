# Provenance-aware flow check (candidate defense, 2026-10-15)

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
- Prompt-level defenses (spotlighting, hardened instructions) are represented here by the `hardened` prompt profile.
- What would make a claim: a measured reduction in attacker-goal rate over the capability-only gateway with no significant
  rise in benign false blocks, on attacks and tasks not used to design the rule, with a held-out evaluation. The current
  evidence is development-split only and the patterns were designed after seeing the marker attack, so it is a candidate.

## Known blind spots

Semantic manipulation in free text (a wrong answer, persuasive wording) carries no identifier or marker and is not caught.
An attacker who avoids marker-shaped tokens evades rule (b). Exact-string matching misses paraphrased or re-encoded tokens.
