#!/usr/bin/env python3
"""Evaluate and summarize the TB-017 provider-backed tuning pilot."""

from __future__ import annotations

import hashlib
import json
import math
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.evaluators import evaluate_outcome

RUN_DIR = ROOT / "runs" / "baseline-pilot"
RAW_PATH = RUN_DIR / "raw-runs.jsonl"
OUTCOMES_PATH = RUN_DIR / "outcomes.jsonl"
REPORT_PATH = RUN_DIR / "report.json"
MANIFEST_PATH = RUN_DIR / "manifest.json"
PREFLIGHT_PATH = RUN_DIR / "preflight-failures.json"
FAST_INPUT_USD_PER_MILLION = 0.20
FAST_OUTPUT_USD_PER_MILLION = 1.00
PRICING_URL = "https://developers.openai.com/api/docs/pricing"


def jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_path(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def metric(records: list[dict[str, Any]], predicate) -> dict[str, Any]:
    denominator_ids = [record["run_id"] for record in records]
    numerator_ids = [record["run_id"] for record in records if predicate(record)]
    return {
        "numerator": len(numerator_ids),
        "denominator": len(denominator_ids),
        "rate": len(numerator_ids) / len(denominator_ids) if denominator_ids else None,
        "numerator_run_ids": numerator_ids,
        "denominator_run_ids": denominator_ids,
    }


def main() -> None:
    raw = jsonl(RAW_PATH)
    if len(raw) != 16:
        raise SystemExit(f"Expected 16 scheduled runs, found {len(raw)}")
    if len({record["episode_id"] for record in raw}) != 16 or len({record["run_id"] for record in raw}) != 16:
        raise SystemExit("Episode and provider run IDs must be unique and non-null")
    attacks = {item["attack_id"]: item for item in jsonl(ROOT / "data" / "attacks.jsonl")}

    outcomes: list[dict[str, Any]] = []
    for record in raw:
        attack = attacks.get(record["attack_id"]) if record["attack_id"] else None
        result = evaluate_outcome(
            record["evaluation_fixture"], record["final_state"], record["tool_records"],
            attack=attack, trace_valid=record["status"] == "waiting" and bool(record["run_id"]),
        )
        usage = record.get("usage") or {}
        input_tokens = int(usage.get("inputTokens", 0))
        output_tokens = int(usage.get("outputTokens", 0))
        api_equivalent_cost_microusd = math.ceil(
            input_tokens * FAST_INPUT_USD_PER_MILLION + output_tokens * FAST_OUTPUT_USD_PER_MILLION
        )
        failures = [
            {"kind": "tool_failure", "tool_name": item["tool_name"], "error_code": item["error_code"]}
            for item in record["tool_records"] if item["status"] != "succeeded"
        ]
        if record["status"] != "waiting":
            failures.append({"kind": "execution_failure", "status": record["status"], "error": record.get("error")})
        if not result.utility_pass:
            failures.append({"kind": "utility_failure", "reason_codes": list(result.reason_codes)})
        if not result.security_pass:
            failures.append({"kind": "security_failure", "reason_codes": list(result.reason_codes)})
        outcomes.append({
            "schema_version": "1.0.0",
            "episode_id": record["episode_id"], "run_id": record["run_id"], "task_id": record["task_id"],
            "attack_id": record["attack_id"], "repetition": record["repetition"],
            "started_at": record["started_at"], "finished_at": record["finished_at"],
            "model_ids": sorted(set(record["model_ids"])), "input_tokens": input_tokens,
            "output_tokens": output_tokens, "api_equivalent_cost_microusd": api_equivalent_cost_microusd,
            "evaluation": result.to_dict(), "failure_records": failures,
        })

    OUTCOMES_PATH.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in outcomes))
    benign_runs = [row for row in outcomes if row["attack_id"] is None]
    attack_runs = [row for row in outcomes if row["attack_id"] is not None]
    model_ids = sorted({model for row in outcomes for model in row["model_ids"]})
    total_input = sum(row["input_tokens"] for row in outcomes)
    total_output = sum(row["output_tokens"] for row in outcomes)
    total_cost = sum(row["api_equivalent_cost_microusd"] for row in outcomes)
    preflight = json.loads(PREFLIGHT_PATH.read_text())
    for failure in preflight["failures"]:
        failure["api_equivalent_cost_microusd"] = math.ceil(
            failure["input_tokens"] * FAST_INPUT_USD_PER_MILLION
            + failure["output_tokens"] * FAST_OUTPUT_USD_PER_MILLION
        )
    preflight_input = sum(item["input_tokens"] for item in preflight["failures"])
    preflight_output = sum(item["output_tokens"] for item in preflight["failures"])
    preflight_cost = sum(item["api_equivalent_cost_microusd"] for item in preflight["failures"])
    failure_counts = Counter(failure["kind"] for row in outcomes for failure in row["failure_records"])
    repeat_counts = Counter((row["attack_id"] or row["task_id"]) for row in outcomes)
    if set(repeat_counts.values()) != {2}:
        raise SystemExit(f"Every tuning case requires two repeats: {dict(repeat_counts)}")

    report = {
        "schema_version": "1.0.0", "task_id": "TB-017", "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": "provider_backed_tuning_pilot_only", "holdout_runs": 0,
        "configuration": {
            "coding_model_not_part_of_evidence": True,
            "runtime_model_ids_observed": model_ids,
            "runtime_model_revision_limitation": "The ChatGPT subscription path returned a moving model alias, not an immutable provider snapshot.",
            "reasoning_effort": "medium", "repeats_per_case": 2, "max_concurrency": 1,
            "synthetic_tools_only": True, "real_external_side_effects": 0,
        },
        "scheduled": {"tuning_cases": len(repeat_counts), "runs": len(outcomes), "run_ids": [row["run_id"] for row in outcomes]},
        "metrics": {
            "all_run_evidence_complete": metric(outcomes, lambda row: row["evaluation"]["evidence_complete"]),
            "benign_utility_pass_rate": metric(benign_runs, lambda row: row["evaluation"]["utility_pass"]),
            "attack_task_utility_pass_rate": metric(attack_runs, lambda row: row["evaluation"]["utility_pass"]),
            "unsafe_committed_effect_rate": metric(attack_runs, lambda row: not row["evaluation"]["security_pass"]),
            "attacker_goal_success_rate": metric(attack_runs, lambda row: row["evaluation"]["attacker_goal_achieved"]),
        },
        "usage": {
            "input_tokens": total_input, "output_tokens": total_output,
            "api_equivalent_cost_microusd": total_cost, "api_equivalent_cost_usd": total_cost / 1_000_000,
            "actual_subscription_charge_reported": None,
            "pricing_at_execution": {
                "date": "2026-10-15", "mode": "Fast", "model": "gpt-6-luna",
                "input_usd_per_million": FAST_INPUT_USD_PER_MILLION,
                "output_usd_per_million": FAST_OUTPUT_USD_PER_MILLION,
                "source": PRICING_URL,
            },
            "run_costs": [{"run_id": row["run_id"], "api_equivalent_cost_microusd": row["api_equivalent_cost_microusd"]} for row in outcomes],
        },
        "failures": {
            "counts": dict(sorted(failure_counts.items())),
            "runs": [{"run_id": row["run_id"], "records": row["failure_records"]} for row in outcomes if row["failure_records"]],
            "preflight_excluded": {
                "count": len(preflight["failures"]), "run_ids": [item["run_id"] for item in preflight["failures"]],
                "input_tokens": preflight_input, "output_tokens": preflight_output,
                "api_equivalent_cost_microusd": preflight_cost,
                "evidence_path": "preflight-failures.json",
            },
        },
        "limitations": [
            "Pilot results are tuning evidence and are excluded from confirmatory holdout claims.",
            "API-equivalent cost uses current Fast-mode API rates; the ChatGPT subscription did not report a per-run billed amount.",
            "Two repeats per case are sufficient for this implementation pilot, not for narrow uncertainty estimates.",
        ],
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
    manifest = {
        "schema_version": "1.0.0", "task_id": "TB-017",
        "artifacts": {
            "raw_runs": {"path": "raw-runs.jsonl", "sha256": sha256_path(RAW_PATH), "records": len(raw)},
            "outcomes": {"path": "outcomes.jsonl", "sha256": sha256_path(OUTCOMES_PATH), "records": len(outcomes)},
            "report": {"path": "report.json", "sha256": sha256_path(REPORT_PATH)},
            "preflight_failures": {"path": "preflight-failures.json", "sha256": sha256_path(PREFLIGHT_PATH), "records": len(preflight["failures"])},
        },
        "source_hashes": {
            "benign_jsonl": sha256_path(ROOT / "data" / "benign.jsonl"),
            "attacks_jsonl": sha256_path(ROOT / "data" / "attacks.jsonl"),
            "splits_json": sha256_path(ROOT / "data" / "splits.json"),
            "agent_instructions": sha256_path(ROOT / "agent" / "instructions.md"),
            "agent_config": sha256_path(ROOT / "agent" / "agent.ts"),
            "eval_source": sha256_path(ROOT / "evals" / "baseline-pilot.eval.ts"),
            "eval_config": sha256_path(ROOT / "evals" / "evals.config.ts"),
            "pilot_store": sha256_path(ROOT / "src" / "pilot" / "store.ts"),
            "evaluator_source": sha256_path(ROOT / "src" / "evaluators" / "outcomes.py"),
            "prepare_source": sha256_path(ROOT / "scripts" / "prepare-baseline-pilot.mjs"),
            "finalize_source": sha256_path(ROOT / "scripts" / "finalize-baseline-pilot.py"),
            "verify_source": sha256_path(ROOT / "scripts" / "verify-baseline-pilot.py"),
            **{
                f"tool_{path.stem}": sha256_path(path)
                for path in sorted((ROOT / "agent" / "tools").glob("*.ts"))
            },
        },
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({
        "runs": len(outcomes), "tuning_cases": len(repeat_counts), "input_tokens": total_input,
        "output_tokens": total_output, "api_equivalent_cost_microusd": total_cost,
        "benign_utility": report["metrics"]["benign_utility_pass_rate"],
        "unsafe_effects": report["metrics"]["unsafe_committed_effect_rate"],
        "failure_counts": report["failures"]["counts"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
