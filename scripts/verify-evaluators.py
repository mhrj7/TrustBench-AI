#!/usr/bin/env python3
"""Generate deterministic TB-016 acceptance evidence."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.evaluators import evaluate_outcome
from tests.evaluators.cases import attacks, bad_utility_state, compromised_trajectory, fixtures, good_trajectory

OUTPUT = ROOT / "evidence" / "tb016-evaluator-report.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    benign = fixtures()
    attack_set = attacks()
    cases: list[dict[str, object]] = []

    for fixture_id in sorted(benign):
        fixture = benign[fixture_id]
        good_state, good_records = good_trajectory(fixture)
        good = evaluate_outcome(fixture, good_state, good_records)
        bad_state, bad_records = bad_utility_state(fixture)
        bad = evaluate_outcome(fixture, bad_state, bad_records)
        assert good.utility_pass and good.security_pass and good.evidence_complete
        assert not bad.utility_pass and bad.evidence_complete
        cases.extend([
            {"case_id": f"{fixture_id}:known-good", "expected": "utility_pass", "result": good.to_dict()},
            {"case_id": f"{fixture_id}:known-bad", "expected": "utility_fail", "result": bad.to_dict()},
        ])

    for attack_id in sorted(attack_set):
        attack = attack_set[attack_id]
        fixture = benign[attack["base_fixture_id"]]
        safe_state, safe_records = good_trajectory(fixture)
        safe = evaluate_outcome(fixture, safe_state, safe_records, attack=attack)
        compromised_state, compromised_records = compromised_trajectory(fixture, attack)
        compromised = evaluate_outcome(fixture, compromised_state, compromised_records, attack=attack)
        assert safe.security_pass and not safe.attacker_goal_achieved and not safe.prohibited_side_effects
        assert not compromised.security_pass and compromised.attacker_goal_achieved and compromised.prohibited_side_effects
        cases.extend([
            {"case_id": f"{attack_id}:safe", "expected": "security_pass", "result": safe.to_dict()},
            {"case_id": f"{attack_id}:compromised", "expected": "attacker_goal_and_security_fail", "result": compromised.to_dict()},
        ])

    attack = attack_set["TB-ATT-EMAIL-001"]
    fixture = benign[attack["base_fixture_id"]]
    state, records = good_trajectory(fixture)
    records.append({
        "call_id": "call-unlisted",
        "tool_name": "write_debug_snapshot",
        "status": "succeeded",
        "arguments": {"scope": "local"},
        "state_change_ids": ["debug-snapshot-001"],
        "error_code": None,
    })
    prohibited_only = evaluate_outcome(fixture, state, records, attack=attack)
    assert not prohibited_only.security_pass and not prohibited_only.attacker_goal_achieved and prohibited_only.prohibited_side_effects
    cases.append({
        "case_id": "prohibited-effect-without-attacker-goal",
        "expected": "security_fail_without_attacker_goal",
        "result": prohibited_only.to_dict(),
    })

    fixture = benign["TB-BEN-DOC-001"]
    state, records = good_trajectory(fixture)
    incomplete = evaluate_outcome(fixture, state, records, trace_valid=False)
    assert not incomplete.evidence_complete and not incomplete.utility_pass and not incomplete.security_pass
    cases.append({"case_id": "invalid-trace", "expected": "evaluation_error", "result": incomplete.to_dict()})

    report = {
        "task_id": "TB-016",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": "deterministic_synthetic_acceptance_only",
        "model_runs": 0,
        "evaluator_version": cases[0]["result"]["evaluator_version"],
        "fixture_hashes": {
            "benign_jsonl_sha256": sha256(ROOT / "data" / "benign.jsonl"),
            "attacks_jsonl_sha256": sha256(ROOT / "data" / "attacks.jsonl"),
        },
        "summary": {
            "known_good_utility_cases": len(benign),
            "known_bad_utility_cases": len(benign),
            "safe_attack_cases": len(attack_set),
            "compromised_attack_cases": len(attack_set),
            "prohibited_effect_without_attacker_goal_cases": 1,
            "invalid_evidence_cases": 1,
            "all_expected_labels_observed": True,
        },
        "cases": cases,
        "limitations": [
            "These are deterministic fixture-derived acceptance cases, not measured live-model performance.",
            "The evaluator reports only the declared synthetic workflows and attack fixtures.",
        ],
    }
    OUTPUT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary"], sort_keys=True))


if __name__ == "__main__":
    main()
