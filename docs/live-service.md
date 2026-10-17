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

## Sessions, accounts and access (TB-039)

| Who | How | What they can do | Kept for |
| --- | --- | --- | --- |
| Guest (default, no sign-up) | The website or CLI asks for an anonymous session on first use | Every mode; see, share and delete their own runs | 24 hours, in that browser or CLI |
| Account | Sign up with email and password, then open the emailed verification link (it signs you in) | The same, on every device; a verified account gets 3× the run limits | 30 days |
| Anyone with a share link | `/live?run=<id>#share=<token>` (the token is in the fragment, so it never reaches server logs) | Read that one run; never change, re-share or delete it | Until the owner revokes it or deletes the run |
| Operator | `TRUSTBENCH_ADMIN_TOKEN` from the secrets manager | List and delete any run; trigger the retention sweep | — |

- **Isolation.** A run is visible only to its owner (the guest session, or the account across its sessions), a holder of
  its share token, or the operator. Anything else gets the same 404 as a run that does not exist, so ids cannot be probed.
- **Accounts.** Passwords: scrypt with a per-password salt, 12 characters minimum, never stored or logged. Five wrong
  passwords lock the account for 15 minutes. Sign-up, sign-in, reset and verification resends answer identically whether
  or not an address is registered (the owner of an existing address is told by email). Verification and reset links are
  single-use and short-lived (48 hours, 1 hour). A password reset signs the account out everywhere; a password change signs
  out every other device. Signing up or in from a guest session moves its runs to the account.
- **Deletion.** Deleting a run removes its record, report, evaluation, spans, policy traces and logs (a running run is
  stopped first). A guest deleting its session, or an account deleting itself (password required), removes every run it
  owns. A retention sweep every 10 minutes deletes guest runs after 24 hours and account runs after 30 days, and expired
  sessions with their guest runs.
- **Quotas.** New sessions per address per hour; runs per address and per session (so neither a new session nor a new
  address escapes the other limit); sign-in and account requests per address per hour; the shared daily budget for the
  project key.
- **Secrets.** `src/service/secrets.py` reads the provider key, operator token, access token and SMTP credentials from the
  environment, a `NAME_FILE` path or `/run/secrets/<name>` (how hosts mount secrets), or the local `.env`; a log filter
  redacts every known secret value. Session, share, verification and reset tokens are stored only as SHA-256 hashes.
- **HTTP.** A strict Content-Security-Policy, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, HSTS,
  `Cache-Control: no-store` on the API, and an 8 KB request limit.
- **Email.** Accounts need outgoing mail: set the SMTP secrets in `.env.example`. Without them, emails go to the
  service's local outbox (development and tests), accounts cannot be verified, and visitors use the site as guests.
- **CLI.** `trustbench remote signup|verify|login|logout|whoami|runs|share|delete`; the session is kept in
  `~/.config/trustbench/sessions.json` (mode 0600), and passwords come from a hidden prompt or `--password-env`, never a flag.
- **Tests.** `tests/api-security/` (28 multi-user tests: isolation, sharing, deletion and retention, accounts and lockout,
  enumeration resistance, quotas, headers, and keys, passwords and tokens never reaching storage, logs or responses).

Not built here: sign-in with Google or GitHub (needs OAuth apps registered for the deployment) and multi-factor
authentication.

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
