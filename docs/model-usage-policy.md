# Model and usage policy

## Two separate model choices

The **coding model** is the model used in Codex to design and implement TrustBench-AI. The **runtime model** is the model executed by TrustBench-AI as the benchmark subject. Changing one does not change the other.

The scaffold currently uses `openai/gpt-6-luna-fast` as its inexpensive runtime model. It is a development default, not the only model the completed benchmark will evaluate and not evidence of reliability or security.

## Coding-model routing

Use the lowest tier that can complete the task accurately, and raise the tier for security-critical decisions or failed reviews.

| Work | Coding model guidance |
| --- | --- |
| Scope, threat model, trust boundaries, experiment protocol, policy invariants | GPT-5.6 Sol medium is the current minimum. Move to high only for a focused final review with unresolved security reasoning. |
| Routine scaffolding, fixture entry, formatting, small deterministic tests, documentation cleanup | Switch to a Luna-class coding model at medium reasoning after the relevant contract is frozen. |
| Gateway authorization logic, approval binding, tenant isolation, replay safety, sandbox policy | Use Sol high for implementation/review. Use Astra high only if the design remains ambiguous or a serious defect survives review. |
| Large refactors and integration debugging | Start with Sol medium. Raise to Sol high after one evidence-backed failed attempt. |
| Holdout design, statistical analysis, negative-result interpretation, novelty and claim audit | Use Sol high. Use Astra high for the final research-claim review if usage permits. |
| Repetitive CI fixes or style-only changes after behavior is established | Luna medium. |

Do not switch models merely because a task is long. Switch when the required reasoning quality changes. Keep one model through a coherent design decision to avoid losing context.

## Usage rules

- Check the five-hour and weekly limits before large architecture or review turns.
- Preserve at least 15% of the five-hour window for verification and unexpected debugging.
- Do not use a full reset while ordinary usage remains available unless a time-critical verified blocker requires it.
- Batch related reads and tests. Avoid repeated broad searches and repeated unchanged test runs.
- Run deterministic local checks before asking a stronger model to investigate.
- Use the stronger model as a reviewer at defined gates instead of for every mechanical task.
- Record model, reasoning effort, date, and purpose for each benchmark run. Coding-model usage does not count as benchmark evidence.

## Model-switch checkpoints

1. Stay on GPT-5.6 Sol medium through TB-006, which freezes scope, threat model, trace contracts, budget, and experiment protocol.
2. After TB-006, use a Luna-class model for data fixtures and ordinary scaffolding. Return to Sol medium for evaluator design.
3. Use Sol high for the policy-gateway phase and its negative tests.
4. Use Luna medium for dashboard, packaging, and routine CI work after security behavior is fixed.
5. Use Sol high for holdout analysis and the claim ledger. Consider Astra high only for the final security/research review.

The coding assistant must announce a recommended switch before beginning the task that needs it. The user changes the model manually.

