# Release check (TB-051)

Candidate `7518c85bee62`, decision **RELEASE** (2026-10-18). Every required check below ran on that commit;
the machine-readable record, with each command's result, is [`tb051-checks.json`](tb051-checks.json) (written by `scripts/release-check.py`).

| Check | Result | Evidence |
| --- | --- | --- |
| CI on GitHub: Tier 1 release gate (scripted, every case and the policy trail against the committed baselines) and the full npm run verify | pass | [GitHub run](https://github.com/mhrj7/TrustBench-AI/actions/runs/39113462375) |
| Tier 2 live release gate (A-025, A-028): the frozen configuration on the development suite with the live model, one attempt per candidate | pass | [evidence/release-gate-release-7518c85bee62-attempt-1.json](../evidence/release-gate-release-7518c85bee62-attempt-1.json) |
| Fresh clone from GitHub: locked install, the pinned AgentDojo data, and the full npm run verify (fixtures, regression, website browser tests), with no local keys | pass | `checks.json` |
| Offline reproduction in a clean container (repro/README.md): every published number rebuilt from the committed raw records | pass | `checks.json` |
| README followed by a fresh non-root user in a clean container (scripts/check-readme.py --fresh) | pass | `checks.json` |
| Demo rebuilt from the candidate's committed files and running healthy | pass | `checks.json` |
| Public live site end to end from outside the host: every mode from the API, the CLI and the browser, report download, own-key form | pass | [GitHub run](https://github.com/mhrj7/TrustBench-AI/actions/runs/39117057661) |
| Live run with a real own key from the CLI against the deployed site, with no key in the output | pass | `checks.json` |
| No-key paths: instant runs, and a spent shared budget degrading to instant and own-key (staging) | pass | `checks.json` |
| Linked reports: every relative link in the documentation resolves, README links answer, and the report, claim, README and reproduction checks pass | pass | `checks.json` |

Tier 2 on the candidate: unsafe committed effect 63.0% undefended against 0.0% defended (-63.0 pp, 95% [-81.5, -44.4], 27 pairs); benign utility +4.8 pp [-9.5, +19.1] (21 pairs). Development data, one attempt.

## What this does not show

A RELEASE decision means the checks above passed on the candidate commit. It is not a full replication of the benchmark: the confirmatory holdouts are not rerun (they were run once, sealed), live model runs are small and sampled, and passing smoke and scripted checks shows the harness and published analyses reproduce, not that a new live study would give the same rates.

## Candidates that were not released

Each was stopped or failed before a decision; the reason and the checks it had passed are kept in its file, and every Tier 2 attempt started is in `evidence/release-gate-ledger.json`.

- [`d60a4c8`](superseded-d60a4c8.json): Stopped before a decision: the linked_reports check read only Markdown [text](url) links and so checked 2 of the README's external links (most are <https://...> autolinks); the check was fixed and a new candidate cut. The Tier 2 attempt started for this candidate is recorded in evidence/release-gate-ledger.json (label release-d60a4c8d24a4) and was stopped within minutes, before any result.
- [`75e4e3d`](superseded-75e4e3d.json): Stopped before a decision: offline_reproduction failed because one scripted trace differed under CPU load. The span code labelled any wait of 1 ms or more before a model call as provider pacing (queue.reason), and scripted runs, which have no pacing, sometimes took that long to resume while the Tier 2 run and an image build were running. Fixed in src/observability/run-spans.ts (the label needs real pacing) with a test; a new candidate was cut. The Tier 2 attempt for this candidate (label release-75e4e3ddce94 in evidence/release-gate-ledger.json) was stopped after about 20 minutes, before any result.
- [`b3164e5`](superseded-b3164e5.json): Not released: fresh_clone_verify failed. In a fresh clone, npm run verify stopped at test:tool-service because pytest could not create its temporary directory under .tool-state/ (the folder does not exist yet; CI never saw it because its Tier 1 step creates the folder first). Fixed in package.json (mkdir -p .tool-state, as the other test scripts do); with the fix the full verify passed in the same fresh clone before a new candidate was cut. The checks that passed here (Tier 2 live gate PASS, offline reproduction, README fresh check, demo rebuild, links, CI) were rerun on the new candidate.
