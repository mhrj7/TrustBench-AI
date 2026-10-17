# Related work (TB-043)

The comparison matrix is [`related-work.csv`](related-work.csv): 24 prior systems and studies plus this project, each with
its threat model, enforcement boundary, evaluation suite, claimed guarantee, reported result, a specific limitation and the
basis for that limitation (stated by the authors, reported by a later work in the matrix, measured on this harness, or our
analysis). Every source was checked against its primary listing on 17 October 2026, and the search was refreshed for
2025–2026 work on that date. `scripts/build-related-work.py` rebuilds the CSV and fails if any row lacks a source or a
specific limitation, names an unknown row as its basis, or quotes a TrustBench number that its evidence file does not contain.

## Where TrustBench sits

| Family | Prior work in the matrix | Boundary | What it guarantees |
| --- | --- | --- | --- |
| Benchmarks | AgentDojo, InjecAgent, ASB, WASP, Liu et al. 2024, AgentDyn, AutoDojo, AgentSecBench, NetInjectBench | none (measurement) | — |
| Prompt and model defenses | Spotlighting, repeat-user-prompt, StruQ, SecAlign, Instruction Hierarchy | inside the prompt or the weights | empirical only |
| Detection and agent-side checks | DataSentinel, MELON, tool filter | before the model or around each call | empirical only |
| System-level enforcement | IsolateGPT, CaMeL, FIDES, RTBAS, Progent, design patterns | outside the model | by construction or formal model (CaMeL, FIDES); deterministic policy (Progent) |
| This project | TrustBench | outside the model, at each tool call | empirical only |

## What TrustBench does not claim

- **Enforcement outside the model is not new.** CaMeL, FIDES, Progent and RTBAS all put a deterministic boundary outside the
  model, and a 2026 adaptive-evaluation study (RW24) describes this as the field's current consensus. TrustBench's
  capability gateway (per-call allowlists and argument contracts) is closest to Progent, its approval pauses to RTBAS's
  confirm-when-unsure rule, and its signed provenance to a narrow, empirical form of FIDES-style integrity tracking.
- **No formal guarantee.** CaMeL and FIDES give guarantees by construction or over a formal model; TrustBench reports only
  measured rates with intervals.
- **No adaptive attacker.** AutoDojo (RW07) shows static benchmarks often significantly overestimate defense efficacy, and
  TrustBench's holdouts use static attack renderings. Its results should be read as upper bounds on robustness until an
  adaptive evaluation is run.
- **Narrow scope.** Three synthetic workflows on small free models; no web agents (WASP), no memory or backdoor attacks
  (ASB), no helpful third-party instructions (AgentDyn), so over-defense of that kind is unmeasured.

## What is specific to TrustBench

These are evaluation and engineering properties, not a new defense idea:

1. **Paired, preregistered, sealed holdouts.** Each attack case runs the undefended and defended agent on identical inputs;
   holdout families were sealed before tuning; differences use a cluster bootstrap over (task, attack) clusters with invalid
   runs counted, not dropped (`docs/uncertainty.md`). Holdout-2: unsafe committed effect 70.0% to 8.3% (−61.7 pp, 95%
   [−81.7, −40.0]); holdout-1's interval includes zero.
2. **Committed effects, not text.** Outcomes are read from tool state (what was actually sent or written), separating
   attacker-goal completion from unsafe effects, the distinction WASP (RW04) found necessary.
3. **Same-harness comparisons.** Re-implementations of spotlighting, repeat-user-prompt, tool filter, MELON and a simplified
   CaMeL were measured on the same paired harness (`docs/defense-comparison.md`, exploratory, 18 attack runs per system).
   They are re-implementations, not the authors' systems, and say nothing about the original papers' numbers.
4. **Operational evidence.** A release gate that blocks verdict regressions and, since TB-042, a policy audit trail that
   became more permissive; fault, restart and rollback drills with measured recovery; a public demo that reruns the
   comparison live.

## Open questions this matrix raises

- An adaptive evaluation (black-box success feedback as in AutoDojo; optimised white-box attacks, which RW24 lists as open)
  against TrustBench's gateway and directive-flow check.
- Tasks with helpful third-party instructions (AgentDyn) to measure over-defense of the flow check.
- Whether the gateway's trust in its signed session and contracts (the analogue of NetInjectBench's metadata-integrity
  assumption) can be weakened by an attacker who influences how contracts are created.

TB-044 tests the project's research hypothesis against these limits.
