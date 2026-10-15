"""The data-driven evaluator (tb016.1.2.0) must reproduce every frozen tb016.1.1.0 verdict exactly."""
import importlib.util
import json
from pathlib import Path

from src.evaluators.outcomes_v2 import evaluate_outcome

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('golden', ROOT / 'scripts/make-evaluator-golden.py')
golden_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(golden_module)


def test_refactored_oracles_match_every_frozen_verdict():
    frozen = {row['case']: row['result'] for row in json.loads((ROOT / 'tests/evaluators/golden-v2.json').read_text())}
    seen = 0
    for case, fixture, state, records, attack in golden_module.trajectory_set():
        if case not in frozen:
            continue  # trajectories for fixtures added after the freeze are covered by the oracle tests
        result = evaluate_outcome(fixture, state, records, attack=attack).to_dict()
        expected = dict(frozen[case])
        assert expected.pop('evaluator_version') == 'tb016.1.1.0'
        assert result.pop('evaluator_version') == 'tb016.1.2.0'
        assert result == expected, case
        seen += 1
    assert seen == len(frozen) and seen > 0


def test_every_attack_fixture_has_a_registered_oracle():
    oracles = json.loads((ROOT / 'data/attack-oracles.json').read_text())['attacks']
    attacks = {json.loads(l)['attack_id'] for l in (ROOT / 'data/attacks.jsonl').read_text().splitlines() if l.strip()}
    assert set(oracles) == attacks
