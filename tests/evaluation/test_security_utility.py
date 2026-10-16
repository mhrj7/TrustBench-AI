"""TB-033 metric computation, tested on the development gate report (never on holdout results)."""
import copy, importlib.util, json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GATE = json.loads((ROOT / 'evidence/release-gate-dev.json').read_text())
REPORT = json.loads((ROOT / GATE['report']).read_text())
spec = importlib.util.spec_from_file_location('security_utility', ROOT / 'scripts/compute-security-utility.py')
su = importlib.util.module_from_spec(spec)
spec.loader.exec_module(su)


def test_recomputation_matches_the_runner_summary_and_the_gate():
    out = su.evaluate_report(REPORT)
    s = REPORT['summary']
    for arm in ('baseline', 'defended'):
        assert out[arm]['rates']['unsafe_committed_effect']['numerator'] == s['unsafe_committed_effect'][arm]['numerator']
        assert out[arm]['rates']['benign_utility_pass']['denominator'] == s['benign_utility_pass'][arm]['denominator']
    t1 = GATE['tolerances']['T1_unsafe_committed_effect']
    assert out['defended']['rates']['unsafe_committed_effect']['rate'] == t1['defended_rate']


def test_every_rate_has_numerator_denominator_interval_and_exclusions():
    out = su.evaluate_report(REPORT)
    for arm in ('baseline', 'defended'):
        for name, x in out[arm]['rates'].items():
            assert {'numerator', 'denominator', 'rate', 'wilson95', 'definition', 'exclusions'} <= set(x), name
            assert 0 <= x['numerator'] <= x['denominator']


def test_invalid_pairs_are_excluded_and_listed_never_counted_secure():
    r = copy.deepcopy(REPORT)
    a = next(c for c in r['cases'] if c['kind'] == 'attack')
    a['defended']['invalid'] = True
    for key in ('unsafe_committed_effect', 'benign_utility_pass', 'attacker_goal_achieved'):  # keep the runner cross-check consistent
        r['summary'][key] = {arm: {'numerator': None, 'denominator': None} for arm in ('baseline', 'defended')}
    with pytest.raises(SystemExit):  # the cross-check refuses a summary that disagrees
        su.evaluate_report(r)
    m, _, _ = su.arm_metrics(r['cases'], 'defended')
    full, _, _ = su.arm_metrics(REPORT['cases'], 'defended')
    x = m['unsafe_committed_effect']
    assert x['denominator'] == full['unsafe_committed_effect']['denominator'] - 1
    assert x['exclusions']['invalid_pairs'] == 1 and f"{a['case_id']}#r{a['repetition']}" in x['exclusions']['invalid_pair_ids']


def test_blocked_task_is_not_a_security_success_on_its_own():
    r = copy.deepcopy(REPORT)
    for c in r['cases']:
        if c['kind'] == 'attack':
            c['defended']['evaluation'] = {**c['defended']['evaluation'], 'security_pass': True, 'attacker_goal_achieved': False, 'utility_pass': False}
    m, _, _ = su.arm_metrics(r['cases'], 'defended')
    assert m['unsafe_committed_effect']['numerator'] == 0
    assert m['secure_and_useful_under_attack']['numerator'] == 0


def test_a_denied_permitted_call_on_a_benign_run_is_a_false_block():
    r = copy.deepcopy(REPORT)
    base, _, _ = su.arm_metrics(r['cases'], 'defended')
    b = next(c for c in r['cases'] if c['kind'] == 'benign' and c['defended']['tool_trace'])
    allowed = su.contracts.benign[b['fixture_id'].split('--')[0]]['task_contract']['allowed_tools']
    step = next(t for t in b['defended']['tool_trace'] if t['tool'] in allowed and not su.contracts.is_defense_denial(t['error']))
    step['error'], step['status'] = sorted(su.contracts.denial_codes)[0], 'failed'
    m, _, _ = su.arm_metrics(r['cases'], 'defended')
    assert m['false_block_rate']['numerator'] == base['false_block_rate']['numerator'] + 1
    assert m['false_block_rate']['denominator'] == base['false_block_rate']['denominator']
