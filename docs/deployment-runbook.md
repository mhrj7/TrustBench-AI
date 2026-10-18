# Deployment runbook: the constrained public demo (TB-041)

The public demo is the website plus the live-test service (`Dockerfile.service`) in one container. Anyone can read the
published results and start instant runs, live runs on the project's free-tier key, or live runs on their own key. This page
says how to deploy it, what limits it runs under, how to check a deployment, and how to operate it.

Status: **public at <https://trustbench.taila273c6.ts.net>** (since 2026-10-17): the compose deployment on the author's
own machine, published with Tailscale Funnel. Checked from outside over the public route: `scripts/check-deployment.py --live`
20 of 20, the browser path (instant and live runs), and the exhausted-budget degradation (`evidence/tb041-deployment.json`).
Hosting choices that were tried and why they were not used are under "Hosting options".

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

## How the public demo is hosted: a Mac with Tailscale Funnel

The compose deployment above runs on the host machine; Tailscale Funnel gives it a public HTTPS name without opening any
port on the router or revealing the home address. Funnel terminates TLS at Tailscale's edge and forwards to the container's
loopback port; it replaces any client-sent `X-Forwarded-For` with the visitor's real address (tested), so the per-client
limits see real clients.

```bash
TRUSTBENCH_DEMO_PORT=8088 docker compose -f deploy/compose.yaml up -d
tailscale funnel --bg 8088          # https://<machine>.<tailnet>.ts.net -> 127.0.0.1:8088; persists across restarts
tailscale funnel status
tailscale funnel --https=443 off    # take the demo offline
```

One-time tailnet setup (admin console): DNS → HTTPS Certificates → Enable (the machine name is then published in the public
certificate log), and Access controls → "Add Funnel to policy" (a `nodeAttrs` entry granting `funnel`).

Checking it from outside: this machine resolves its own name to the tailnet address, so run the checker in a container with
public DNS, which sends every request through Tailscale's public relay:

```bash
docker run --rm --dns 1.1.1.1 --entrypoint sh trustbench-live:demo -c \
  ".venv-tools/bin/python scripts/check-deployment.py --url https://<machine>.<tailnet>.ts.net --live"
```

Checking it from a machine that is not the host: `.github/workflows/public-demo-check.yml` runs on GitHub's runners, a
quick check every 6 hours (no runs, no quota) and, on demand, the full live check plus the browser path
(`scripts/check-deployment-gui.mjs`). From the host itself the public relay route stopped answering ("hairpin"), while
outside clients and the tailnet route work; host-side checks therefore use the tailnet route and say so in their evidence.

### Restart behaviour

| Event | What brings the demo back | Tested |
| --- | --- | --- |
| The server process crashes | `init: true` (a real PID 1) exits with it, `restart: unless-stopped` restarts the container | SIGKILL of the server: healthy again in 8 s |
| Docker Desktop restarts | Docker restarts `unless-stopped` containers | quit and reopen: healthy 36 s after start |
| The container is stopped, or Funnel is reset | the watchdog LaunchAgent (every 5 minutes, `deploy/install-watchdog.sh`) | both broken at once: repaired in 21 s |
| Funnel shows as on but its public DNS record is gone (seen on 2026-10-17: outside visitors got "name not found" for about ten hours while the site worked inside the tailnet) | the watchdog resolves the name through a public resolver every 5 minutes; after 10 minutes it resets and re-publishes Funnel, after 25 minutes (and every 30 after that) it reconnects Tailscale with the machine's own settings | dry run of every step; the real incident was fixed by the same reset and reconnect (the record returned some minutes after the reconnect, so which step restored it is not certain) |
| Login after a reboot | Docker Desktop `AutoStart`, Tailscale as a login item, then the two rows above | not rebooted during testing |
| Power failure | needs "Start up automatically after a power failure" (System Settings → Energy), set by the owner | — |

`docker stop` is now clean (the server is exec'd, so it receives SIGTERM). The watchdog does not read the project drive
(background jobs cannot read external volumes without a macOS privacy grant), so it is embedded in the LaunchAgent and
logs to the system log as `trustbench-watchdog`. Availability is still best effort: a network outage or a machine that is
off takes the demo down, and the README says so.

### Keeping the host's files private

- Docker Desktop's file sharing is limited to `/Volumes/MHRJ/TrustBench-AI` (setting `FilesharingDirectories`): a
  container cannot mount the home folder, other folders on the drive or `/private/tmp` (tested; Docker refuses with "not
  shared from the host"). The demo mounts only its two secret files and its own data volume.
- The demo container runs read-only as uid 1000 with no capabilities; Funnel publishes only its port, nothing else on the
  machine is reachable from the internet, and Funnel replaces any client-sent `X-Forwarded-For` (tested).
- Docker's disk image lives on the project drive (`DataFolder` = `/Volumes/MHRJ/DockerData`), not the internal disk.
- No personal name in the public address: the tailnet machine is named `trustbench`. Committed test reports carry
  `hostname="redacted"` (root `conftest.py`). The earlier machine name remains in the public certificate-transparency log,
  which cannot be edited.

## Hosting options (checked 2026-10-17)

| Option | Result |
| --- | --- |
| Mac + Tailscale Funnel | **Used.** Free, 2 CPUs and 3 GB as capped by compose, stable HTTPS name. Depends on the machine staying on. |
| Hugging Face Space | Docker and Gradio Spaces now need the paid PRO plan; only static Spaces are free. Works with `scripts/deploy-hf-space.py` if PRO is bought. |
| Oracle Cloud Always Free (Ampere A1) | "Out of capacity" for A1 in the account's home region (Hyderabad, one availability domain) on five attempts. |
| Small free container tiers (512 MB, 0.1 vCPU) | Measured unusable: instant run 248 s, live run 466 s with a pair lost to a timeout. |
| Google Cloud Run | Fits (instance-based billing, scale to zero), needs a billing account; state resets when it scales to zero. |
| Vercel | Static site only; cannot run the live-test service. |

## Alternative: a Hugging Face Space (needs PRO)

A Docker Space (PRO plan; 2 vCPU, 16 GB) runs the image unchanged, serves it over HTTPS at
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
- **Updating:** commit, tag the release (`git tag -a release-<name>`), build the image from the committed tree
  (`git archive HEAD | docker build -f Dockerfile.service -t trustbench-live:<sha> -`), `up -d --no-build`, then `check-deployment.py`.

### Backup and rollback (TB-042, measured in `reports/rollback-drill.md`)

- **Back up the demo's data** (online, the demo keeps serving): `sh deploy/backup-demo.sh` writes a verified backup to
  `backups/` on the project drive (gitignored). `scripts/backup.py verify --backup backups/<name>` re-checks one.
- **Restore it:** stop the demo, restore into the volume, start it:
  `docker compose -f deploy/compose.yaml stop`, then
  `docker run --rm -v trustbench-demo_service-data:/data -v "$PWD/backups:/in:ro" --entrypoint .venv-tools/bin/python trustbench-live:demo scripts/backup.py restore --backup /in/<name> --dest /data/restored`
  and move the restored tree into place (the restore never deletes what it replaces), then `up -d`. A backup that fails
  its manifest is refused.
- **Roll the deployment back:** `TRUSTBENCH_IMAGE=trustbench-live:<previous release> TRUSTBENCH_DEMO_PORT=8088 docker compose -f deploy/compose.yaml up -d --no-build`
  (same data volume; measured 6 s to healthy on staging).
- **Roll configuration back:** `git checkout <release> -- configs`, then the Tier 1 gate against that release
  (`scripts/release-gate-scripted.py --baseline-ref <release>`), which now also blocks a policy audit trail that became
  more permissive.
- **Sign-in with Google or GitHub:** deferred until the site is public and the remaining phases are done; email accounts
  need `TRUSTBENCH_SMTP_*` secrets, otherwise visitors use guest sessions (TB-039).
