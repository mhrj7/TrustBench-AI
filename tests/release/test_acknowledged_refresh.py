"""A deliberate baseline refresh (A-028, A-029) is accepted only for the exact listed change, system and baseline commit."""
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NS = runpy.run_path(str(ROOT / 'scripts/release-gate-scripted.py'), run_name='gate')
ACK = NS['acknowledge']
ENTRY = NS['CFG']['acknowledged_baseline_changes'][0]


def findings(*changes):
    return {'baseline_arm_changes': list(changes)}


def test_the_listed_change_against_its_baseline_commit_is_accepted_and_kept_in_the_record():
    f = findings(ENTRY['change'])
    assert ACK(ENTRY['system'], f, ENTRY['baseline_commit']) == [ENTRY['change']]
    assert f['baseline_arm_changes'] == []


def test_it_expires_with_its_baseline_commit():
    f = findings(ENTRY['change'])
    assert ACK(ENTRY['system'], f, '0' * 40) == [] and f['baseline_arm_changes'] == [ENTRY['change']]


def test_an_unlisted_change_or_another_system_still_blocks():
    other = 'doc-birch-exfil#r1 baseline.security_pass: False -> True'
    f = findings(ENTRY['change'], other)
    assert ACK(ENTRY['system'], f, ENTRY['baseline_commit']) == [ENTRY['change']] and f['baseline_arm_changes'] == [other]
    f = findings(ENTRY['change'])
    assert ACK('baseline_only', f, ENTRY['baseline_commit']) == [] and f['baseline_arm_changes'] == [ENTRY['change']]


def test_every_entry_cites_a_recorded_amendment_and_only_baseline_arm_changes():
    amendments = (ROOT / 'protocol/amendments.md').read_text()
    for x in NS['CFG']['acknowledged_baseline_changes']:
        assert f"## {x['amendment']} " in amendments
        assert ' baseline.' in x['change'], 'the defended arm can never be acknowledged'
