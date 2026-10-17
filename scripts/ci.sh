#!/bin/sh
# Release-gate CI steps (A-028, TB-038). The GitHub Actions workflow calls these; they run the same way locally or in a
# container, so the CI path can be checked without GitHub.
#   sh scripts/ci.sh setup     locked install: npm ci, tools venv, review-site dependencies, pinned AgentDojo data
#   sh scripts/ci.sh tier1     Tier 1 gate against the baseline ref, then the injected-regression tests
#   sh scripts/ci.sh verify    the full credential-free verification suite
#   sh scripts/ci.sh tier2 L   Tier 2 live gate for release candidate L (needs the provider key in the environment)
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in
  setup)
    cp -n .env.example .env 2>/dev/null || true
    npm ci --no-audit
    npm run setup
    sh bin/trustbench fetch-data
    ;;
  tier1)
    .venv-tools/bin/python scripts/release-gate-scripted.py
    .venv-tools/bin/python -m pytest -q tests/release
    ;;
  verify)
    npm run verify
    ;;
  tier2)
    [ -n "${2:-}" ] || { echo "usage: ci.sh tier2 <label>" >&2; exit 2; }
    .venv-tools/bin/python scripts/release-gate.py live --label "$2"
    ;;
  *)
    echo "usage: ci.sh setup|tier1|verify|tier2 <label>" >&2
    exit 2
    ;;
esac
