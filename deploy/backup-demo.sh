#!/bin/sh
# TB-042: back up the public demo's data volume (sessions, accounts, runs, budget record) to backups/ on the project drive,
# while the demo keeps running (SQLite online backup). Restore: docs/deployment-runbook.md, "Backup and rollback".
set -eu
cd "$(dirname "$0")/.."
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
docker run --rm -v trustbench-demo_service-data:/data:ro -v "$PWD/backups:/out" --entrypoint .venv-tools/bin/python \
  "${TRUSTBENCH_IMAGE:-trustbench-live:demo}" scripts/backup.py backup --source /data --dest "/out/demo-$stamp" --label "public demo $stamp"
.venv-tools/bin/python scripts/backup.py verify --backup "backups/demo-$stamp"
