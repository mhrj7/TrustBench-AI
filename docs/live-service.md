# Live-test website and service

The public website (the review site plus a **Live** page) and its API let anyone run the paired benchmark without
installing anything. It is built for a reviewer with no time and possibly no API key: there is always something that runs.

## Three ways to run, from the browser or the command line

| Mode | Model | Whose key | When it is available | Limits (`configs/live-service.yaml`) |
| --- | --- | --- | --- | --- |
| Live, our key (`hosted`) | NVIDIA free tier (frozen model `gpt-oss-20b`, or Llama 3.2 11B) | The project's, set as a host secret and read only on the server | When the host has the key and today's shared budget is not used up | 4 paired runs per run, 3 runs per visitor per day, 60 pairs per day in total |
| Live, your key (`own_key`) | NVIDIA or Gemini free tier | The visitor's, sent once with the request | Always | 16 paired runs per run, 6 runs per visitor per hour |
| Instant (`scripted`) | None: scripted trajectories | None | Always | 34 paired runs per run |

If the project key is missing or the day's budget is spent, the page says so and offers the other two modes. If the API
itself is unreachable (a static-only copy of the site), the page says so and links the published results; the command
line runs everything locally from a checkout.

- **GUI:** `/live` on the website: pick a mode, defense, model, attack wording and cases, watch progress, then read the
  verdicts, the per-case table, the metrics with intervals, and download the report. Every run has a shareable link
  (`/live?run=<id>`), kept for 24 hours.
- **CLI:** `sh bin/trustbench remote catalog|run|status|report --url <site>`; the Live page's "From the command line" tab
  prints the commands for the site you are on. Plain HTTP works too (`/api/docs` has the OpenAPI reference).

## What a run is

The same harness as the study: `scripts/run-arm-smoke.mjs` runs the baseline agent and the chosen defended system on the
same development-suite cases (`tests/arms/smoke-cases.json`) with the same seeds and settings, in a directory of its own.
The frozen system uses the frozen reliability settings. Results are the arm-comparison report (valid against
`schemas/arm-report.schema.json`), the TB-033 metrics and the TB-034 paired intervals. A small live run is a
demonstration of the harness, not a new estimate; the study's results are on the site's overview and in `docs/`.
Sealed holdouts are never listed, accepted or run.

## Keys and safety

- The project key lives only in the host environment (`NVIDIA_API_KEY`); it is never sent to a browser, written to a
  job record or included in any response. It is passed to the runner only for hosted runs.
- A visitor's key is accepted only in the request body (the CLI reads it from an environment variable the visitor names,
  never from a flag), held in memory for that run, passed to the runner's environment, and dropped when the run ends. It is
  never written, logged or returned. The runner is told not to read `.env`, so a visitor's run can never fall back to the
  project key.
- Before a run's results are served, every file it produced is scanned for both keys; a match deletes the artifacts and
  fails the run (tested in `tests/service`).
- Per-visitor rate limits, a shared daily budget reserved at submission, request size limits, input validation against the
  catalog (no free-form URLs or providers), one live run at a time, and 24-hour retention. An optional access token
  (`TRUSTBENCH_DEMO_TOKEN`) can close run creation if a deployment is abused.
- Hardening tracked in the roadmap: TB-039 (authentication, per-user isolation, quotas, retention jobs), TB-040 (faults and
  resource exhaustion), TB-041 (constrained public deployment with spend caps).

## Connecting your own agent (planned, phase 10)

The API already takes an `agent` field. Today only `trustbench_baseline` is available; `external_mcp` and `langgraph_http`
are reserved and answer "planned". Phase 10 (TB-055..TB-066) adds the adapters: an external agent (LangGraph or a
customer's own tool-calling agent) is connected through the website or the CLI, its tool calls are routed through the
TrustBench gateway, and it receives the same paired report. Two modes are planned: the agent uses the TrustBench tool
services, or it keeps its own tool integration against a sandbox with the gateway interposed (TB-057).

## Deploy

`Dockerfile.service` builds the website and the service into one container (base images pinned by digest; Node 26.5.0,
npm 12.0.0, Python 3.14.0). Any container host works; set `NVIDIA_API_KEY` as a secret to enable the hosted mode.

```bash
docker build -f Dockerfile.service -t trustbench-live .
```

```bash
docker run --rm -p 8080:8080 --env-file .env trustbench-live
```

Locally without Docker: `npm run service` (API on port 8080) and `npm run web:dev` (the site, proxying `/api`).

## Verification (`evidence/live-service-verification.json`)

- Local service and site: a scripted run, a hosted live run (frozen system, 2 pairs) and an own-key run (a dummy key: every
  pair invalid with code `authentication`, explained in plain words, and the project key not used) through the browser;
  `trustbench remote` against the same service.
- The deployable container, built from a clean clone: without a project key it serves the site and the published data,
  reports hosted mode as unavailable and still runs scripted and own-key runs; with the key as a host secret it completes a
  hosted live run, and no file in its service data contains the key.
- Tests: `tests/service`, `tests/cli` and `web/tests/live.spec.ts` (desktop, tablet, mobile), all in `npm run verify`.

Not done here: the public deployment and link (TB-041), the hardening in TB-039/TB-040, and external agents (phase 10).
