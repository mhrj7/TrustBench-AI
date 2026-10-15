#!/usr/bin/env python3
"""Strict acceptance verifier for the stored TB-017 pilot."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN_DIR = ROOT / "runs" / "baseline-pilot"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


manifest = json.loads((RUN_DIR / "manifest.json").read_text())
report = json.loads((RUN_DIR / "report.json").read_text())
raw = [json.loads(line) for line in (RUN_DIR / "raw-runs.jsonl").read_text().splitlines() if line]
outcomes = [json.loads(line) for line in (RUN_DIR / "outcomes.jsonl").read_text().splitlines() if line]
splits = json.loads((ROOT / "data" / "splits.json").read_text())
tuning_ids = {
    fixture_id
    for group in splits["groups"]
    if group["split"] == "tuning"
    for fixture_id in group["fixture_ids"]
}
observed_ids = [row["attack_id"] or row["task_id"] for row in raw]

assert manifest["task_id"] == "TB-017"
assert len(raw) == len(outcomes) == 16
assert len({row["run_id"] for row in raw}) == 16
assert len({row["episode_id"] for row in raw}) == 16
assert set(observed_ids) == tuning_ids
assert set(Counter(observed_ids).values()) == {2}
assert all(row["status"] == "waiting" for row in raw)
assert all(row["usage"] and row["usage"]["inputTokens"] > 0 and row["usage"]["outputTokens"] > 0 for row in raw)
assert all(row["evaluation"]["evidence_complete"] for row in outcomes)
assert {(row["episode_id"], row["run_id"]) for row in raw} == {(row["episode_id"], row["run_id"]) for row in outcomes}
assert report["holdout_runs"] == 0
assert report["scheduled"]["runs"] == 16
assert set(report["scheduled"]["run_ids"]) == {row["run_id"] for row in raw}
assert report["configuration"]["repeats_per_case"] == 2
assert report["configuration"]["real_external_side_effects"] == 0
assert report["usage"]["actual_subscription_charge_reported"] is None
for name, entry in manifest["artifacts"].items():
    path = RUN_DIR / entry["path"]
    assert path.is_file(), name
    assert sha256(path) == entry["sha256"], name
source_paths = {
    "benign_jsonl": ROOT / "data" / "benign.jsonl",
    "attacks_jsonl": ROOT / "data" / "attacks.jsonl",
    "splits_json": ROOT / "data" / "splits.json",
    "agent_instructions": ROOT / "agent" / "instructions.md",
    "agent_config": ROOT / "agent" / "agent.ts",
    "eval_source": ROOT / "evals" / "baseline-pilot.eval.ts",
    "eval_config": ROOT / "evals" / "evals.config.ts",
    "pilot_store": ROOT / "src" / "pilot" / "store.ts",
    "evaluator_source": ROOT / "src" / "evaluators" / "outcomes.py",
    "prepare_source": ROOT / "scripts" / "prepare-baseline-pilot.mjs",
    "finalize_source": ROOT / "scripts" / "finalize-baseline-pilot.py",
    "verify_source": ROOT / "scripts" / "verify-baseline-pilot.py",
    **{f"tool_{path.stem}": path for path in sorted((ROOT / "agent" / "tools").glob("*.ts"))},
}
assert set(manifest["source_hashes"]) == set(source_paths)
for name, path in source_paths.items():
    assert sha256(path) == manifest["source_hashes"][name], name
for metric in report["metrics"].values():
    assert metric["denominator"] == len(metric["denominator_run_ids"])
    assert metric["numerator"] == len(metric["numerator_run_ids"])
    assert set(metric["numerator_run_ids"]).issubset(metric["denominator_run_ids"])
print(json.dumps({"task_id": "TB-017", "runs": 16, "metrics_linked_to_run_ids": True, "artifact_hashes_verified": True}))
