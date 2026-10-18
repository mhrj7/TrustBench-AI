# TrustBench-AI

TrustBench-AI is a local-first evaluation and enforcement project for tool-using AI agents. The core release uses synthetic data and mock tools to compare bounded baseline and defended configurations without real external side effects.

This is an [eve](https://eve.dev) agent bootstrapped with [`eve init`](https://eve.dev/docs/reference/cli#eve-init).

## Try it live (no setup)

The TrustBench website has a **Run it live** page (`/live`): run the paired benchmark from the browser with the project's
free-tier key, with your own free-tier key, or instantly with no model at all, then read the verdicts and download the
report. The same runs work from a terminal with `sh bin/trustbench remote run --url <site> ...`. Keys stay server-side or
in memory for one run; sealed holdouts are never offered. Details and limits: [`docs/live-service.md`](docs/live-service.md); deploying
and checking the public demo: [`docs/deployment-runbook.md`](docs/deployment-runbook.md).

**Live demo: <https://trustbench.taila273c6.ts.net/live>**. Open it and press Run: instant runs need nothing, live runs use the
project's free-tier key (shared daily cap), or bring your own free-tier key. Same from a terminal:
`sh bin/trustbench remote run --url https://trustbench.taila273c6.ts.net --mode hosted --wait`. Self-hosted on the author's
machine behind Tailscale Funnel, so it is best effort: if it is down, every published result is in this repository.

## Benchmark quickstart (TB-037)

To reproduce the published results offline from a clean clone (no key, model or network), follow
[`repro/README.md`](repro/README.md) (TB-046, release tag `repro-tb046`).

Requirements: Node.js 26.5.0 with npm 12.0.0 (`package.json` engines), [uv](https://docs.astral.sh/uv/) (it installs Python
3.14.0 from `.python-version`), and git. The project expects its storage root at `/Volumes/MHRJ`; anywhere else, set
`TRUSTBENCH_STORAGE_ROOT` to the parent of the checkout and `npm_config_cache` to `$TRUSTBENCH_STORAGE_ROOT/.cache/npm`.

```bash
cp .env.example .env
npm ci
npm run setup
```

`setup` runs `setup:python`, which creates `.venv-tools` from the hash-pinned locks (`src/tools/requirements.lock`,
`requirements/analysis.lock`), and `setup:web`, which installs the review site's locked dependencies (`web/package-lock.json`).
The full `npm run verify` also runs the site's browser tests, which use an installed Google Chrome.
Then the CLI (`bin/trustbench`, also `npm run trustbench -- <command>`), configured by `configs/cli/trustbench.yaml`:

```bash
sh bin/trustbench validate
```

```bash
sh bin/trustbench smoke --check
```

```bash
sh bin/trustbench manifest
```

```bash
sh bin/trustbench report --check
```

| Command | What it does | Needs credentials |
| --- | --- | --- |
| `validate` | Fixture, split, sealed-manifest, protocol and frozen-configuration checks | no |
| `fetch-data` | Clones the pinned AgentDojo checkout from `data/manifest.json` and verifies it | no (network) |
| `smoke [--check]` | Environment fixture, scripted smoke suite and scripted arm comparison; `--check` compares each output with the committed result (ignoring the volatile fields listed in the config) and validates the arm report against `schemas/arm-report.schema.json` | no |
| `benchmark <profile> [--dry-run]` | A live paired run on development data from `configs/cli/benchmark-<profile>.yaml` (`dev-frozen`: the frozen configuration; `dev-local-ollama`: a local model) | yes for hosted models: your own key in `.env` and free-tier quota |
| `evaluate <report>...` | Security and utility rates (TB-033) and paired cluster-bootstrap intervals (TB-034) | no |
| `report [--check]` | Regenerates the published TB-033..TB-036 reports from raw records, or runs their reproduction tests | no |
| `manifest [--write]` | Checks the pinned hashes of data, locks, frozen configuration, schema and protocol (`manifests/pinned.json`) | no |
| `remote catalog\|run\|status\|report --url <site>` | The same runs on a live-test service (the website's API); `--mode scripted\|hosted\|own_key`, your key read from `--key-env` | only for `own_key`: your own key |

The same checks in a clean container:

```bash
docker build -f Dockerfile.bench -t trustbench-bench .
```

```bash
docker run --rm trustbench-bench
```

Live benchmark runs call a model provider and need your own credentials and budget; the sealed holdouts are excluded from
every development run and cannot be rerun. `docs/benchmark-cli.md` records the fresh-environment reproduction.

## Getting started

The project is designed to live at `/Volumes/MHRJ/TrustBench-AI`. Install the locked dependencies and run the credential-free verification suite:

```bash
cp .env.example .env
npm ci
npm run verify
```

The environment and clean-install procedure are documented in [`docs/development-environment.md`](docs/development-environment.md). Project storage requirements are in [`docs/storage-policy.md`](docs/storage-policy.md).

After verification, start the development server with `npm run dev`. A provider-backed interactive session may require credentials; the TB-003 smoke fixture does not.

The development TUI opens an interactive session where you can send messages to your agent.

Start by editing `agent/instructions.md` to define the agent's identity, purpose, tone, and response guidelines. Configure its model and runtime behavior in `agent/agent.ts`.

Add capabilities under `agent/`, including tools, connections, channels, skills, subagents, and schedules. eve reloads your changes as you work.

## Learn more

To learn more about eve, explore these resources:

- [eve documentation](https://eve.dev/docs) — learn about eve's features and authoring APIs.
- [Build an Agent tutorial](https://eve.dev/docs/tutorial/first-agent) — build and deploy an agent step by step.
- [eve on GitHub](https://github.com/vercel/eve) — view the source and contribute.

## Deploy on Vercel

Deploy your agent to [Vercel](https://vercel.com) from the project root:

```bash
eve deploy
```

`eve deploy` links a Vercel project if needed and deploys the agent to production. See the [eve deployment documentation](https://eve.dev/docs/guides/deployment/vercel) for authentication, environment variables, and deployment options.
