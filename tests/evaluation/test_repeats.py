"""TB-028 acceptance: changing run order does not change task pairing or denominators."""
import json
import random
import subprocess
from pathlib import Path

import pytest

from src.evaluation.repeats import build_schedule, evaluate, load_runs

ROOT = Path(__file__).resolve().parents[2]


def case(task, attack, rep, *, b_ok=True, d_ok=True, b_valid=True, d_valid=True, kind=None):
    fid = task if attack is None else f'{task}--{attack}'
    side = lambda ok, valid: {'invalid': not valid, 'evaluation': {'utility_pass': ok, 'security_pass': ok, 'attacker_goal_achieved': not ok}}
    return {'case_id': f'{task}-{attack}', 'fixture_id': fid, 'attack_id': attack, 'repetition': rep, 'kind': kind or ('benign' if attack is None else 'attack'),
            'baseline': side(b_ok, b_valid), 'defended': side(d_ok, d_valid)}


def report(cases, system='sys'):
    return {'defended_system': system, 'cases': cases}


CASES = [case('T1', None, r, d_ok=r != 2) for r in (1, 2, 3)] + [case('T2', None, r) for r in (1, 2, 3)] + \
        [case('T1', 'A1', r, b_ok=False, d_ok=True) for r in (1, 2, 3)] + [case('T3', 'A2', r, b_ok=r == 1, d_valid=r != 3) for r in (1, 2, 3)]


def test_shuffled_input_gives_identical_results():
    reference = json.dumps(evaluate(load_runs([report(CASES)])), sort_keys=True)
    rng = random.Random(7)
    for _ in range(20):
        shuffled = CASES[:]
        rng.shuffle(shuffled)
        split = rng.randint(1, len(shuffled) - 1)  # also split across reports
        assert json.dumps(evaluate(load_runs([report(shuffled[:split]), report(shuffled[split:])])), sort_keys=True) == reference


def test_per_cluster_frequency_all_repeats_and_denominators():
    out = evaluate(load_runs([report(CASES)]))['systems']['sys']['metrics']
    benign = out['benign']
    t1 = next(c for c in benign['clusters'] if c['task_id'] == 'T1')
    assert t1['defended'] == {'successes': 2, 'valid_repeats': 3, 'invalid_repeats': 0, 'outcomes_by_repetition': [True, False, True]}
    d = benign['arms']['defended']
    assert d['clusters_with_valid_repeats'] == 2 and d['valid_repeats'] == 6
    assert d['mean_success_frequency'] == round((2 / 3 + 1) / 2, 4)
    assert d['all_repeats_success_rate'] == 0.5 and d['any_repeat_success_rate'] == 1.0
    assert d['clusters_with_mixed_outcomes'] == 1
    goal = out['attack_goal']['arms']['defended']
    assert goal['invalid_repeats_excluded'] == 1 and goal['valid_repeats'] == 5, 'invalid repeats are excluded and counted, never scored'


def test_duplicates_rejected_and_missing_units_reported():
    with pytest.raises(ValueError, match='duplicate'):
        load_runs([report(CASES), report(CASES[:1])])
    schedule = build_schedule([{'case_id': 'b', 'fixture_id': 'T1', 'kind': 'benign'}, {'case_id': 'x', 'fixture_id': 'T9', 'kind': 'benign'}], repetitions=3)
    integrity = evaluate(load_runs([report(CASES)]), schedule)['systems']['sys']['integrity']
    assert integrity['missing_units'] == ['T9|none|r1', 'T9|none|r2', 'T9|none|r3']
    assert 'T2|none|r1' in integrity['unscheduled_units']


def test_schedule_order_changes_order_but_not_units_or_seeds():
    cases = [{'case_id': c, 'fixture_id': f, 'kind': 'benign'} for c, f in (('a', 'T1'), ('b', 'T2'), ('c', 'T3'))]
    s1, s2 = build_schedule(cases, repetitions=4, order_seed=1), build_schedule(cases, repetitions=4, order_seed=2)
    assert s1['content_sha256'] == s2['content_sha256'] and s1['order_sha256'] != s2['order_sha256']
    key = lambda s: sorted((e['unit_id'], e['seed']) for e in s['entries'])
    assert key(s1) == key(s2)
    with pytest.raises(ValueError, match='unique'):
        build_schedule([{'case_id': 'a', 'fixture_id': 'T1', 'kind': 'benign'}, {'case_id': 'a2', 'fixture_id': 'T1', 'kind': 'benign'}], repetitions=1)


def test_correlated_repeats_are_measured():
    perfectly_clustered = [case('T1', None, r, d_ok=True) for r in (1, 2, 3)] + [case('T2', None, r, d_ok=False) for r in (1, 2, 3)]
    arm = evaluate(load_runs([report(perfectly_clustered)]))['systems']['sys']['metrics']['benign']['arms']['defended']
    assert arm['intra_cluster_correlation'] == 1.0, 'repeats of one task are fully correlated here'
