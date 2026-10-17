# Deployment runbook: the constrained public demo (TB-041)

The public demo is the website plus the live-test service (`Dockerfile.service`) in one container. Anyone can read the
published results and start instant runs, live runs on the project's free-tier key, or live runs on their own key. This page
says how to deploy it, what limits it runs under, how to check a deployment, and how to operate it.

Status: verified in staging (local compose, and the exact image a Space builds). **Not yet at a public URL:** that needs a
public GitHub repository for the README link and a hosting account, which only the project owner can create (see
"Going public").

## What is exposed, and what is not

| Public, no sign-in | Needs a session (created automatically, no sign-up) | Operator only (`TRUSTBENCH_ADMIN_TOKEN`) | Not exposed at all |
| --- | --- | --- | --- |
| The site and every published result (read-only, built into the image); `/api/catalog`, `/api/health`, `/api/docs` | Starting a run; reading, sharing and deleting your own runs | Listing and deleting any run; the retention sweep (unknown or forged tokens get 404) | Sealed holdouts; free-form models, providers, URLs or attack text (runs use only the synthetic development suite and its fixed attack wordings); the project key; benchmark credentials |

## Limits (the `public-demo` deployment profile)

`configs/deploy/public-demo.json`, switched on with `TRUSTBENCH_DEPLOY_PROFILE`. A profile can only tighten
`configs/live-service.yaml`: a value above the base limit, an unknown setting or a new mode is refused at startup, and a mode
can be switched off but not on (`apply_profile` in `src/service/app.py`, tested in `tests/deploy`).

| Mode | Per run | Per visitor | Shared |
| --- | --- | --- | --- |
| Live, project key | 2 paired runs, 1 repetition | 3 runs a day per client; 10 runs an hour per session | 40 pairs a day, reserved at submission |
| Live, your key | 8 paired runs | 4 runs an hour | none (the visitor's own free-tier quota) |
| Instant | 34 paired runs | 20 runs an hour per client; 10 an hour per session | none (no model) |

Every provider is a free tier (NVIDIA; Gemini for own-key runs), so no run is billed; the caps protect the project key's
free-tier quota. When the day's shared budget is spent, the Live page says so ("today's shared budget is used up"), opens
on the instant mode, and hosted submissions get 429; instant and own-key runs carry on.

## Run it with Docker Compose (any host, and staging)

```bash
mkdir -p deploy/secrets && chmod 700 deploy/secrets
printf '%s' "$YOUR_NVIDIA_FREE_TIER_KEY" > deploy/secrets/nvidia_api_key
python3 -c "import secrets; print(secrets.token_urlsafe(32), end='')" > deploy/secrets/trustbench_admin_token
chmod 600 deploy/secrets/*
docker compose -f deploy/compose.yaml up -d --build
```

`deploy/secrets/` is gitignored and excluded from the image build context (`.dockerignore`); the secrets reach the container
as files under `/run/secrets` (read through `NAME_FILE`). The container runs as uid 1000 with a read-only root
filesystem, all capabilities dropped, `no-new-privileges`, 512 processes, 3 GB and 2 CPUs; only `/tmp`, the runner's
`.tool-state` (tmpfs) and the `service-data` volume (sessions, accounts, runs for 24 hours, the budget record) are
writable. It binds `127.0.0.1:8080`: put the host's TLS proxy in front (`TRUSTBENCH_TRUST_PROXY=1` is set, so the client
address comes from `X-Forwarded-For`). Without the key file the site still serves the results, instant and own-key runs,
and the hosted mode says it has no key.

## Going public: a Hugging Face Space (free, recommended)

A Docker Space on the free CPU hardware (2 vCPU, 16 GB) runs the image unchanged, serves it over HTTPS at
`https://<user>-<space>.hf.space`, and keeps the key in its secret store. The owner does these steps; each needs their own
account or credentials, which this project never holds:

1. Publish the repository on GitHub (the README link points at it) and create a Hugging Face account.
2. Create a Hugging Face write token and put it in the environment: `export HF_TOKEN=...` (never in a file in the repository).
3. Deploy the committed tree and set the two secrets from `deploy/secrets/`:

   ```bash
   uv run --with huggingface_hub==0.30.2 python scripts/deploy-hf-space.py --space <user>/trustbench --set-secrets
   ```

   The script uploads `git archive HEAD` only (no uncommitted or gitignored file can be included), uses
   `Dockerfile.service` as the Space's `Dockerfile` with the `public-demo` profile switched on, and adds the Space metadata
   to the uploaded README copy. `--stage-only <dir>` writes the tree without uploading, to build and test it locally.
4. When the Space shows "Running", check it from outside:

   ```bash
   .venv-tools/bin/python scripts/check-deployment.py --url https://<user>-trustbench.hf.space --live --out evidence/tb041/check-public-url.json
   ```

5. Replace `<!-- Public link: added at deployment (TB-041). -->` in `README.md` with the URL.

**Without a Hugging Face token** (how the public demo was set up): create the Space in the browser (Docker SDK, blank,
free CPU, public), then add two files made by
`python3 scripts/deploy-hf-space.py --space <user>/<space> --stage-only <dir> --from-github <owner>/<repo>`: a README with
the Space metadata and a `Dockerfile` that is `Dockerfile.service` with `COPY . .` replaced by a clone of the public
repository pinned to one commit. Add `NVIDIA_API_KEY` (and optionally `TRUSTBENCH_ADMIN_TOKEN`) under the Space's
Settings → Variables and secrets. To update, regenerate the Dockerfile at the new commit and replace it in the Space.

Space limits to know: a free Space sleeps after 48 hours without visits and wakes on the next visit (the first page load
then waits for the container to start); its disk is ephemeral, so a restart clears sessions, runs and the day's budget
record (the provider's own free-tier limits still apply); compose's read-only and capability settings are not available
there, while the uid, secrets and profile are the same.

## Checking a deployment

`scripts/check-deployment.py --url <site> [--live] [--exhaust]` checks, from outside: health; the site pages and security
headers (HSTS on https); the catalog (no sealed case, the profile and its limits, no secret material); that run creation
needs a session, operator endpoints refuse no or forged tokens, another visitor cannot see a run, and an oversize request
is refused; an instant run from the API (what the site does) and from the CLI (`trustbench remote`), with the report valid
against `schemas/arm-report.schema.json`; with `--live`, a live run on the project key from the API and the CLI and an own-key
run whose key the provider rejects (it must come back as an explicit invalid run with reason `authentication`); with
`--exhaust` (staging with `configs/deploy/staging-tiny-budget.json` only), that a spent budget makes hosted refuse with a
clear message while the other modes work; and that the per-visitor rate limit stops runs. It exits 1 on any failure.

Staging results (`evidence/tb041-deployment.json`, `evidence/tb041/`): 20 of 20 checks passed on the compose deployment
with the public profile (live runs included), 20 of 20 on the staging profile with the budget exhausted, and 20 of 20 on
the exact Space image run as a Space runs it; a live run and an instant run were also completed in the browser, and the
exhausted-budget page was checked there. The project key and operator token were not found anywhere in either image's
filesystem, nor in the run data or logs after live runs.

## Operating it

- **Health:** `GET /api/health` (`ok`, `storage`); the image has a Docker `HEALTHCHECK` on it. With unwritable storage the
  service stays up in a degraded mode (TB-040): results and catalog served, sessions and runs 503.
- **Spend:** the day's shared use is in `service-data/hosted-budget.json`; `/api/catalog` shows `remaining_pairs_today`.
  To stop live runs on the project key at once, remove the key secret and restart, or deploy a profile with
  `"hosted": {"enabled": false}`; to close run creation entirely, set `TRUSTBENCH_DEMO_TOKEN`.
- **Abuse or a leaked key:** rotate the NVIDIA key at the provider, update the secret, restart; `GET /api/admin/runs` and
  `DELETE /api/runs/<id>` with the operator token list and remove runs.
- **Updating:** commit, rerun `scripts/deploy-hf-space.py` (or `docker compose up -d --build`), then `check-deployment.py`.
  Rollback and backup restore are TB-042.
- **Sign-in with Google or GitHub:** deferred until the site is public and the remaining phases are done; email accounts
  need `TRUSTBENCH_SMTP_*` secrets, otherwise visitors use guest sessions (TB-039).
