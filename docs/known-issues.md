# Known issues, limits and caveats

Living register. Each item says whether it is **open**, **partly addressed** or **fixed**, with the evidence or next step.
Numbers are not copied here; they live in the generated or evidence files referenced, so this page cannot drift from them.

## Research claim

| # | Item | Status | Detail / next step |
| --- | --- | --- | --- |
| R1 | Policy did not use provenance labels | **Partly addressed** | Provenance-aware flow check added as the default defended variant (`docs/flow-check.md`, INV-09 tests, ablation test in `tests/arms.test.ts`, live comparison in `docs/pilot-results-tb024.md`, including a live run where the flow check blocked an injected marker that the capability-only gateway would have allowed, and its benign-run denial counts). Designed on the development split after seeing the marker attack: a candidate, not a validated contribution. |
| R2 | Free-text injection inside authorized writes | **Partly addressed** | Identifier/marker/address flows are blocked (R1). Semantic manipulation (wrong answer, persuasive text without such tokens) is still not caught. |
| R3 | Baseline attack success depends on the shared prompt | **Open (decision needed)** | Both `plain` and `hardened` profiles are measured. Before any confirmatory run, register which profile is primary. Recommendation: `plain` as primary (it is the ordinary agent), `hardened` as a secondary strong baseline. |
| R4 | No novelty claim is supported yet | **Open** | No comparison against an implemented external defense (for example CaMeL or spotlighting) exists; only against our own capability-only gateway. |
| R5 | Pilot-sized evidence | **Open** | Few attack goals and tasks, 3–5 repetitions, a handful of models; wide intervals; no paired test claimed. |
| R6 | Thin sealed holdout | **Open** | Only the record-update workflow has a holdout (16.7% vs registered 20%, tolerance declared); document and email have none; designed after development results were seen; its oracle is tested only on synthetic trajectories. |
| R7 | Amendments after exposure | **Disclosed** | A-001 to A-010 in `protocol/amendments.md`, including the holdout exposure incident (A-005). Development results are seen; confirmatory honesty depends on keeping these visible. |

## Measurement

| # | Item | Status | Detail / next step |
| --- | --- | --- | --- |
| M1 | Live matrix incomplete | **Open** | Unfinished cells are generated in `docs/pilot-results-tb024.md`. Gemini free quota (20 requests/day/model) blocks it; NVIDIA Llama-11B is slow. Local models above about 9B do not fit the 16 GB machine; hosted models run remotely. |
| M2 | No pinned model snapshots | **Open** | Hosted aliases can change; every response records its model ID. Gemini rejects `seed`. Live runs use temperature 0.3. |
| M3 | Gateway latency overhead | **Fixed (component)** | `evidence/gateway-overhead-report.json` (in-process, per call). End-to-end latency is dominated by model calls; cost per task (TB-M7) is zero on free tiers and not meaningful yet. |
| M4 | "Unsafe effect" mixes attacker goals and out-of-allowlist tool use | **Partly addressed** | The generated table splits out "unlisted-tool use only". The plain profile has a high per-call block rate on benign tasks; benign utility is reported separately. |
| M5 | Contract-checked backend ablation not run live | **Open** | `--tool-mode contract` exists; run it when the matrix resumes. |
| M6 | Recovery evaluated with synthetic faults only | **Open** | `evidence/tb025-recovery-report.json`; LLM behavior after failed or unknown-outcome writes is unmeasured. |

## Gateway and approval

| # | Item | Status | Detail / next step |
| --- | --- | --- | --- |
| G1 | Approval is synthetic | **Open** | The approver is a fixture event matched by a host CLI, not a human interface. |
| G2 | Exactly-once only for local SQLite actions | **Open (by design)** | No claim for external APIs. |
| G3 | Sessions are in memory | **Open** | A gateway restart needs re-binding: TB-026. |
| G4 | Provenance labels are lineage, not authenticity | **Open (by design)** | Free-form model text mixes sources. |
| G5 | LangGraph covers only the approval workflow | **Open** | The agent loop is a custom state machine; the TypeScript agent calls the Python approval graph through a subprocess. |
| G6 | Exact-ID matching | **Open (by design)** | Normalization gaps are tested (INV-02) but not proven absent. |

## Engineering hygiene

| # | Item | Status | Detail / next step |
| --- | --- | --- | --- |
| E1 | Hardcoded values in runtime code | **Fixed** | Policy, providers, prompts, tool descriptions, run settings, attack oracles and renderings are config/data. `tests/no-hardcoding.test.ts` enforces it. Two explicit exemptions: the frozen v1 evaluator and the eve pilot agent definition (both hash-pinned by the TB-017 pilot). Tests and verification scripts may name the fixtures they exercise. |
| E2 | API keys typed into the tracked `.env.example` | **Guarded** | Moved to the gitignored `.env`; `npm run verify:env-example` fails if it happens again. Never paste keys in chat. |
| E3 | Ollama listens on all network interfaces | **Open (host setting)** | Turn off "Expose Ollama to the network" in the Ollama app settings. |
| E4 | Workbook formula caches | **Open** | openpyxl does not compute formulas; open the workbook in Excel to refresh the dashboard counts. |
| E5 | Older notes in `docs/local-models.md` | **Partly addressed** | Marked as predating later changes; current numbers are in the generated results file. |
| E6 | Paid providers | **Not used** | No OpenAI credits; OpenAI is intentionally absent from `configs/providers.yaml`. |
