# CaMeL-style baseline (`camel`)

A re-implementation of the architecture in Debenedetti et al. 2025, *Defeating Prompt Injections by Design* (CaMeL), on this
harness, so the TrustBench defenses can be compared against an information-flow design and not only against prompt-level
defenses. It is not the original code. Registered in `configs/defenses.yaml` (`systems.camel`, `architectures.camel`), code in
`src/agent/camel.ts`, tests in `tests/camel.test.ts`, pre-registration and disclosed tuning in protocol amendment A-014.

## How it works

1. **Privileged planner.** The model sees the system prompt, the user's task and the tool specs, and writes a plan
   (`configs/prompts/defenses/camel-planner.md`). It never sees a tool output.
2. **Interpreter.** Tool steps run in order. Query steps send earlier tool results to a **quarantined extractor** (the same
   model, no tools, `camel-query.md`), which returns one typed value or reports insufficient information.
3. **Capabilities.** Every value carries its sources: the planner's own literals are trusted (`user`); tool results and
   anything extracted from them carry `tool:<name>`.
4. **Policy.** Before a write, the arguments registered as control arguments for that tool (recipients, record and draft
   IDs, update values; all arguments of `send_external_email`) must be trusted. Otherwise the call is refused with
   `camel_policy_denied` and never executes. Values extracted from tool output may flow into data arguments (answers, bodies).
5. **Replanning.** After a failure the planner gets only the step id, error code and finished step ids
   (`camel-replan.md`), never data, up to `max_replans` times.

## Simplifications (disclosed in the system's family label)

- A JSON plan instead of Python code, and linear plans without loops or branches.
- One model plays both roles; the paper allows different models.
- No "readers" side of the capability model; the policy only restricts which sources may reach control arguments.
- The planner prompt was given a flat step format and one generic example after a first sanity run produced malformed plans
  (A-014). This was tuned for plan validity, not for security outcomes.

## Expected behavior

By design it stops control-flow attacks: injected recipients or record IDs cannot reach a write because the planner writes
those as literals. It does not stop poisoning that flows into an allowed data argument (an injected false answer extracted
into a research note). The paper names this as out of scope for its policies. Extractor calls are reported as defense
overhead, like MELON's. Results are generated in `docs/defense-comparison.md`.
