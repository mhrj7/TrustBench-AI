#!/usr/bin/env python3
"""TB-057: prove the external agent and its native integration are unmodified.

goose and its native integration (the bundled Computer Controller, `goose mcp computercontroller`) ship in one release
binary. This check (1) verifies the release archive against the SHA-256 digest GitHub publishes for it (pinned in
configs/external-agents.yaml), (2) extracts the binary from that archive and compares it byte for byte with the binary the
adapter runs (TRUSTBENCH_GOOSE_BIN), whose own checksum must equal the pinned one, and (3) shows the repository carries no
goose source, patch or binary: everything TrustBench adds is the adapter under src/external/. Writes
evidence/tb057-unmodified.json.

usage: scripts/verify-external-unmodified.py --archive <downloaded goose release archive>
"""
import argparse
import filecmp
import hashlib
import json
import os
import platform
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "evidence" / "tb057-unmodified.json"


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", required=True)
    args = ap.parse_args()
    cfg = json.loads((ROOT / "configs" / "external-agents.yaml").read_text())
    agent = cfg["agents"]["goose"]
    key = f"{'darwin' if sys.platform == 'darwin' else 'linux'}-{'arm64' if platform.machine() in ('arm64', 'aarch64') else 'x64'}"
    artifact = agent["artifacts"][key]
    problems: list[str] = []
    archive = Path(args.archive)
    archive_sha = sha256(archive)
    if archive.name != artifact["archive"]:
        problems.append(f"archive name {archive.name} is not the pinned {artifact['archive']}")
    if archive_sha != artifact["archive_sha256"]:
        problems.append("release archive checksum differs from the digest GitHub publishes (pinned)")
    used = os.environ.get(agent["binary_env"])
    used_path = Path(used) if used else None
    used_sha = sha256(used_path) if used_path and used_path.exists() else None
    if used_sha is None:
        problems.append(f"{agent['binary_env']} is not set to an existing binary")
    elif used_sha != artifact["binary_sha256"]:
        problems.append("the binary the adapter runs differs from the pinned checksum")
    identical = False
    with tempfile.TemporaryDirectory() as tmp:
        with tarfile.open(archive) as t:
            member = next(m for m in t.getmembers() if Path(m.name).name == "goose")
            t.extract(member, tmp, filter="data")
        extracted = Path(tmp) / member.name
        extracted_sha = sha256(extracted)
        if used_path and used_path.exists():
            identical = filecmp.cmp(extracted, used_path, shallow=False)
            if not identical:
                problems.append("the binary the adapter runs is not byte-identical to the one in the release archive")
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
    goose_files = [f for f in tracked if Path(f).name == "goose" or "/goose/" in f or f.endswith((".rs", "Cargo.toml"))]
    if goose_files:
        problems.append(f"repository tracks goose files: {goose_files[:5]}")
    result = {
        "task_id": "TB-057", "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "agent": {"name": "goose", "version": agent["version"], "tag": agent["tag"], "commit": agent["commit"]},
        "native_integration": {"name": "computercontroller", "ships_in": "the same goose release binary", "expected_server": cfg["native_integrations"]["computercontroller"]["expected_server"]},
        "platform": key,
        "archive": {"name": archive.name, "sha256": archive_sha, "matches_published_digest": archive_sha == artifact["archive_sha256"]},
        "binary": {"extracted_sha256": extracted_sha, "used_sha256": used_sha, "pinned_sha256": artifact["binary_sha256"], "byte_identical_to_release": identical},
        "repository": {"tracked_goose_files": goose_files, "trustbench_additions": sorted(f for f in tracked if f.startswith("src/external/"))},
        "problems": problems, "ok": not problems,
    }
    OUT.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({k: result[k] for k in ("archive", "binary", "ok")}, indent=1))
    for p in problems:
        print("  -", p)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
