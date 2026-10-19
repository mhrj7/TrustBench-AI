# TrustBench-AI

TrustBench measures whether a tool-using AI agent can be kept from committing unsafe effects when the content it reads
carries injected instructions, without breaking the user's task. It runs the same agent with and without a defense on
identical synthetic tasks and reads the outcome from what the tools actually committed. Everything runs locally on
synthetic data and mock tools; no real email is sent and no real record changes.

- **Results:** [`research/report.md`](research/report.md), the technical report (not peer reviewed; every number maps to a
  stored artifact). What is and is not claimed: [`research/claims.md`](research/claims.md).
- **How it fits together**, with a walkthrough of real runs and a video: [`docs/architecture.md`](docs/architecture.md).
- **Reproduce the published numbers offline** from a clean clone: [`repro/README.md`](repro/README.md).

## Try it live (nothing to install)

**<https://trustbench.taila273c6.ts.net>**: pick a mode and press *Run*. You get a guest session automatically.

| Mode | What it needs | Limit per run |
| --- | --- | --- |
| Instant, no model | nothing (scripted trajectories; the gateway and evaluator are real) | 34 paired runs |
| Live, our key | nothing (the project's free-tier key, shared daily budget) | 2 paired runs; 3 runs a day per visitor |
| Live, your key | your own free-tier NVIDIA or Gemini key, used for that run only and never stored | 8 paired runs |

Results show unsafe-effect and task-success verdicts for both arms with Wilson intervals; *Download report JSON* gives the
full record. The site is self-hosted on the author's machine behind Tailscale Funnel, so it is best effort: if it is down,
every published result is in this repository.

The same three modes from a terminal need only the Python tools ([uv](https://docs.astral.sh/uv/) and git):

```bash
git clone https://github.com/mhrj7/TrustBench-AI.git
cd TrustBench-AI
sh scripts/setup-python.sh
sh bin/trustbench remote run --url https://trustbench.taila273c6.ts.net --mode scripted --wait
sh bin/trustbench remote run --url https://trustbench.taila273c6.ts.net --mode hosted --system gateway_directive_flow_v4 --wait
```

With your own key, put it in an environment variable and name the variable (the key is never passed on the command line):

```bash
export NVIDIA_API_KEY=<your free-tier key>
sh bin/trustbench remote run --url https://trustbench.taila273c6.ts.net --mode own_key --system gateway_directive_flow_v4 --model nvidia:openai/gpt-oss-20b --key-env NVIDIA_API_KEY --wait
sh bin/trustbench remote report <run id from the output> --url https://trustbench.taila273c6.ts.net --out report.json
```

For Gemini use `GEMINI_API_KEY` and `--model gemini:gemma-4-26b-a4b-it`. `sh bin/trustbench remote catalog --url <site>`
lists every mode, model, defense and case the site offers. Service details and limits: [`docs/live-service.md`](docs/live-service.md).

## Install

Tested environments (nothing else is claimed):

| Environment | Where it was run |
| --- | --- |
| macOS 27.2, Apple silicon | the author's machine: full `npm run verify` |
| Debian 12 (`node:26.5.0-bookworm-slim`), arm64, non-root, fresh clone | this README's install and check steps (`scripts/check-readme.py --fresh`) |
| Ubuntu 24.04, x86_64 (GitHub Actions) | full `npm run verify` on every push |

Requirements: git, Node.js 26.5.0 with npm 12.0.0, and [uv](https://docs.astral.sh/uv/) 0.11.28 (it installs Python 3.14.0
from `.python-version`). Google Chrome is needed only for the website's browser tests; Docker only for the container
checks and the self-hosted demo.

```bash
git clone https://github.com/mhrj7/TrustBench-AI.git
cd TrustBench-AI
export TRUSTBENCH_STORAGE_ROOT="$(dirname "$PWD")" npm_config_cache="$(dirname "$PWD")/.cache/npm"
cp .env.example .env
npm ci
npm run setup
```

`TRUSTBENCH_STORAGE_ROOT` is the folder that holds the checkout, its npm cache and its run data: the environment check
refuses to run from anywhere else, so export it (and `npm_config_cache`) in every new shell. `npm run setup` creates
`.venv-tools` from the hash-pinned Python locks and installs the website's locked dependencies. If `npm --version` is
not 12.0.0, run `npm install -g npm@12.0.0` first.

## Check the install (no key, no model, no network)

```bash
sh bin/trustbench validate
sh bin/trustbench smoke --check
sh bin/trustbench manifest
sh bin/trustbench report --check
```

Each command exits 0 when the install is correct. What it prints:

| Command | Expected output (excerpt) |
| --- | --- |
| `sh bin/trustbench validate` | `"ok": true` first, then one entry per check, for example `"step": "verify:frozen"` |
| `sh bin/trustbench smoke --check` | `"ok": true`, and `"matches_committed": true` for the smoke suite and the arm comparison |
| `sh bin/trustbench manifest` | `"ok": true` and `"changed": []` |
| `sh bin/trustbench report --check` | a pytest summary ending in `passed` and no `failed` |

`validate` skips the AgentDojo-derived check unless the pinned AgentDojo checkout is present (`sh bin/trustbench
fetch-data`, network). The full suite, `npm run verify`, also runs the website's browser tests and needs Google Chrome.

## API keys (only for live runs)

Live runs call a hosted model. Use a free tier; no run in this project is billed.

| Provider | Variable | Get a key | Models |
| --- | --- | --- | --- |
| NVIDIA | `NVIDIA_API_KEY` | <https://build.nvidia.com> | `nvidia:openai/gpt-oss-20b` (the frozen configuration), `nvidia:meta/llama-3.2-11b-vision-instruct` |
| Google Gemini | `GEMINI_API_KEY` | <https://aistudio.google.com> | `gemini:gemma-4-26b-a4b-it` |
| Ollama (local) | none | <https://ollama.com> | any local model, `--model ollama:<name>` |

Put the key in `.env` (gitignored) or export it; never commit it (`npm run verify` fails if `.env.example` gets a value).
Then:

```bash
sh bin/trustbench benchmark dev-frozen --dry-run
sh bin/trustbench benchmark dev-frozen
```

`--dry-run` prints the exact runner command and the key variable it needs, and runs nothing. Without the key, the live run
stops before any request with `NVIDIA_API_KEY is not set in the environment or .env`. Live runs use development cases
only: the sealed holdouts are excluded by the runner and cannot be rerun.

## Budget controls

- **Per run:** each provider has a budget file (`configs/budget-nvidia-free.yaml`, `configs/budget-gemini-free.yaml`,
  `configs/budget-local.yaml`) that caps model calls, tool calls, input and output tokens, retries, elapsed time and
  computed cost. Crossing any cap ends the run with outcome `budget_exhausted`, records which limit was hit, and cancels
  pending work ([`docs/budget-policy.md`](docs/budget-policy.md)). Lower a value to spend less.
- **Per benchmark:** the profile (`configs/cli/benchmark-dev-frozen.yaml`) sets the cases and repetitions; requests are
  paced per model to stay inside the free tier's rate limit.
- **On the live site:** `configs/live-service.yaml` sets the per-run, per-visitor and daily limits, and a deployment
  profile (`configs/deploy/public-demo.json`) can only lower them.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `trustbench: .../.venv-tools is missing` | Python tools not installed | `sh scripts/setup-python.sh` (or `npm run setup`) |
| `uv: command not found` | uv not installed | install uv from <https://docs.astral.sh/uv/>, then rerun setup |
| `npm ci` stops with an engine error | Node or npm version differs | Node.js 26.5.0 and `npm install -g npm@12.0.0` |
| npm fails to create `/Volumes/MHRJ/.cache/npm` | the project `.npmrc` names the author's cache; `npm_config_cache` was not exported | the `export ... npm_config_cache=...` line from Install (it overrides `.npmrc`) |
| smoke fails with `Project must run from ...` or an npm cache mismatch | storage root not exported in this shell | the `export TRUSTBENCH_STORAGE_ROOT=... npm_config_cache=...` line from Install |
| `smoke --check` reports a difference | code or data changed since the committed results | `git status`; a deliberate change needs its baselines regenerated and reviewed |
| `manifest` lists `changed` files | a hash-pinned file was edited | restore it with `git checkout -- <file>`; repinning (`manifest --write`) is only for a recorded amendment |
| `NVIDIA_API_KEY is not set ...` | live run without a key | add the key to `.env` (API keys) |
| live run reports invalid pairs, `rate_limit` or `429` | free-tier quota or rate limit | wait and rerun; invalid pairs are listed and never counted as secure |
| outcome `budget_exhausted` | a per-run cap was reached | fewer cases, or raise the cap in the provider's budget file (local runs only) |
| `npm run verify` fails in the website tests | Google Chrome not installed | install Chrome, or run the four checks above |
| a run was interrupted | process killed | rerun it; a write whose outcome is unknown is flagged, never retried blindly ([`docs/recovery.md`](docs/recovery.md)) |
| live site: "today's shared budget is used up" | the day's project-key budget is spent | use instant mode or your own key; it resets daily |
| live site: `429` | per-visitor limit | wait an hour (instant, own key) or a day (project key) |
| live site unreachable | the self-hosted demo is down | every result is in this repository; reproduce offline with [`repro/README.md`](repro/README.md) |

## Working on the agent

The repository is an [eve](https://eve.dev) agent project: the agent's instructions are `agent/instructions.md` and its
model is set in `agent/agent.ts`. `npm run dev` starts eve's development session; it calls the configured model provider
and is not part of the tested setup above.

## Hosting the demo yourself

Docker Compose and Tailscale Funnel setup, limits, checks and operations: [`docs/deployment-runbook.md`](docs/deployment-runbook.md).

## License

MIT ([`LICENSE`](LICENSE)). Third-party material and what is redistributed: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
