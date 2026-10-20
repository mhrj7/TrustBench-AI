# External agent selection (TB-055)

**Selected: goose 1.55.0** (<https://github.com/aaif-goose/goose>), Apache-2.0, tag `v1.55.0`, commit
`2bcb8583a18a0623eb78c9ed845d597ed99fae48`, macOS arm64 release artifact `goose-aarch64-apple-darwin.tar.bz2` with SHA-256
`007322bcd885f29b4ff5a0d4c4aaa15bfc5dc8b1ac9b57f3a8a8818e5c88d407` (matches the digest GitHub publishes for the asset).

The agent's core is not modified. Everything TrustBench adds sits in a separate, documented adapter (TB-057, `src/external/`)
that uses goose's public interfaces only: command-line flags, environment variables and MCP extensions. If a change to goose
itself ever became necessary, the phase stops and the change is recorded before any result is claimed.

Facts below were read from the GitHub API and the pinned tag on 2026-10-20. The probes were run the same day; their scripts
and outputs are in `evidence/tb055-agent-probes/`.

## Selection criteria (fixed before scoring)

From the TB-055 row in the workbook, plus one criterion TB-056 and TB-057 depend on, and one that decides between candidates
that pass the rest.

| # | Criterion | How it is checked |
| --- | --- | --- |
| C1 | Developed independently of TrustBench | Repository created before this project, maintained by others, no TrustBench code |
| C2 | Open-source licence permitting evaluation and an adapter | OSI licence on the repository |
| C3 | Tool or function calling | Documented tool interface, and a real tool call in the probe |
| C4 | Runs on free models or local Ollama | The probe passes on local `qwen3.5:9b` (Ollama) and on the NVIDIA free tier (`gpt-oss-20b`) |
| C5 | Active maintenance | A release in the last 60 days and commits in the last 30 |
| C6 | Pinned release | A tagged release, its commit, and an artifact or package version that can be fixed |
| C7 | Integrable without modification | An external tool interface (function tools or MCP) the adapter can route through the gateway, built-in tools that can be switched off, and an independently implemented integration for TB-057's native mode |
| C8 | A complete agent, not only a framework (tie-breaker) | Its own system prompt, loop and tool routing, so TrustBench does not author the behaviour it measures |

## Candidate pool

| Candidate | Licence | Created | Last push | Latest release | Screening result |
| --- | --- | --- | --- | --- | --- |
| goose (`aaif-goose/goose`) | Apache-2.0 | 2024-08-23 | 2026-10-20 | v1.55.0, 2026-10-16 | Shortlisted |
| OpenAI Agents SDK (`openai/openai-agents-python`) | MIT | 2025-03-11 | 2026-10-20 | v0.24.0, 2026-10-15 | Shortlisted |
| Agno (`agno-agi/agno`) | Apache-2.0 | 2022-05-04 | 2026-10-19 | v3.1.6, 2026-10-19 | Shortlisted |
| Pydantic AI (`pydantic/pydantic-ai`) | MIT | 2024-06-21 | 2026-10-20 | v2.58.0, 2026-10-20 | Not shortlisted: a framework covering the same ground as the OpenAI Agents SDK; fails C8 |
| LangGraph (`langchain-ai/langgraph`) | MIT | 2023-08-09 | 2026-10-19 | 2026-10-19 | Not shortlisted: TrustBench already uses LangGraph for its approval workflow, which weakens C1, and the agent graph would be written by us (C8) |
| CrewAI (`crewAIInc/crewAI`) | MIT | 2023-10-27 | 2026-10-20 | 1.15.28, 2026-10-14 | Not shortlisted: multi-agent orchestration adds layers between the model and the tools; a framework (C8) |
| Microsoft Agent Framework (`microsoft/agent-framework`) | MIT | 2025-04-28 | 2026-10-19 | python-1.22.0, 2026-10-15 | Not shortlisted: a young framework overlapping the OpenAI Agents SDK (C8) |
| smolagents (`huggingface/smolagents`) | Apache-2.0 | 2024-12-05 | 2026-10-06 | v1.26.0, 2026-05-29 | Not shortlisted: no release in the last 60 days (C5); its default agent runs model-written Python, a tool path outside any gateway (C7) |
| AutoGen (`microsoft/autogen`) | CC-BY-4.0 on the repository | 2023-08-18 | 2026-10-16 | python-v0.7.5, 2025-09-30 | Rejected: no release in over a year (C5) |
| Open Interpreter (`openinterpreter/openinterpreter`) | Apache-2.0 | 2023-07-14 | 2026-10-11 | rust-v0.0.56, 2026-10-07 | Rejected: built around executing code and shell commands, which are tool paths a gateway cannot see (C7) |

## Shortlist scores

Probe: one synthetic tool (`lookup_policy_tier`), one question whose answer is only in the tool's result, run on both free
models. A pass needs a real tool call and the answer from its result. The same question and tool were used for every agent.

| Criterion | goose 1.55.0 | OpenAI Agents SDK 0.24.0 | Agno 3.1.6 |
| --- | --- | --- | --- |
| C1 independent | Yes: created 2024-08-23 by Block, now its own organisation | Yes: OpenAI | Yes: Agno |
| C2 licence | Apache-2.0 | MIT | Apache-2.0 |
| C3 tool calling | Yes, through MCP extensions | Yes, function tools and MCP | Yes, function tools, toolkits and MCP |
| C4 local `qwen3.5:9b` | Pass: called the tool with `Cedar`, answered Silver | Pass | Pass |
| C4 NVIDIA `gpt-oss-20b` | Pass | Pass | Pass |
| C5 maintenance | Release 2026-10-16; 100+ commits in the last 30 days | Release 2026-10-15 | Release 2026-10-19 |
| C6 pin | Tag, commit and artifact checksum | Tag, commit and PyPI version | Tag, commit and PyPI version |
| C7 integrable unmodified | MCP for every tool; `--no-profile` leaves only the extensions passed on the command line plus `load_skill`; independent MCP servers available for native mode | Function tools and MCP; tracing goes to OpenAI by default and must be disabled | Built-in toolkits (SQL, email and others) suit native mode; telemetry is on by default and must be disabled |
| C8 complete agent | Yes: its own prompt, loop and tool routing | No: a framework; we would write the agent | No: a framework; we would write the agent |
| Result | **Selected** | Fallback | Rejected |

Commits: OpenAI Agents SDK `v0.24.0` is `17d994bd3045dae71acda676a4ef4762ed8ecd94`; Agno `v3.1.6` is
`7a567275bc5d0634628592b287993d4c2af9f514`.

## Why goose, and why not the others

- **goose** is the only shortlisted candidate that is a whole agent. TrustBench would supply tools and a task, not the prompt
  or the loop, so a result on it says something about an agent nobody tuned for this benchmark. Every tool reaches it
  through MCP, which gives the adapter one place to put the gateway, and the same holds for an independently written MCP
  server in TB-057's native mode.
- **OpenAI Agents SDK** passes every hard criterion and is the fallback. It loses on C8: with a framework, the system prompt,
  tool descriptions and loop limits are TrustBench's choices, which is closer to the agents already measured. If goose
  cannot be integrated without modification (TB-056, TB-057), switching to it needs a recorded amendment before any run.
- **Agno** passes the hard criteria and its built-in toolkits are the strongest for native integration, but it also fails C8
  and sends telemetry unless told not to. It stays a fallback for native mode only.

## How the probes ran (no data left the machine beyond the model call)

- Each candidate ran in its own isolated environment outside the repository, from the pinned version.
- goose ran headless (`goose run --no-session --no-profile --with-extension <probe MCP server>`) with a throwaway home
  folder, the keyring disabled and `GOOSE_TELEMETRY_ENABLED=false`; its usage data is opt-in per its documentation. The
  OpenAI Agents SDK ran with tracing disabled and Agno with telemetry off.
- Keys were read from the gitignored `.env` and never printed; the saved outputs were checked for keys and machine paths.

## Open items handed to TB-056 and TB-057

- **Tool surface:** with `--no-profile`, the model reported two tools, the probe's and goose's built-in `load_skill`, which
  reads instruction files from disk. TB-056 must classify `load_skill` as an entry point (untrusted unless the skills
  folder is controlled) and confirm the tool list from the adapter's MCP trace rather than the model's report. The
  `developer` extension (shell and file editing) is part of the default profile and was not loaded; it must stay off.
- **Native mode:** goose's own built-in extensions, or an independently written MCP server pointed at a synthetic sandbox,
  with the gateway as an MCP proxy in between. Not demonstrated yet.
- **Traces:** goose's structured output (`--output-format`) and the gateway's MCP proxy are the candidate trace sources for
  the TB-004 schema.
- **Platform:** the pinned artifact is the macOS arm64 build; the Linux CI image needs the matching Linux artifact of the
  same tag, with its own checksum recorded.
