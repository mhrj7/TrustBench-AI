"""TB-051: the release decision passes only when every required check passed on the same candidate commit."""
import json, runpy, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HEAD = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def decide_with(tmp_path, checks, candidate=HEAD):
    ns = runpy.run_path(str(ROOT / 'scripts/release-check.py'), run_name='rc')
    out = tmp_path / 'checks.json'
    out.write_text(json.dumps({'task_id': 'TB-051', 'candidate': candidate, 'checks': checks}))
    ns['decide'].__globals__['OUT'] = out
    ns['load'].__globals__['OUT'] = out
    ok = ns['decide']()
    return ok, json.loads(out.read_text())['decision']


def all_passed(cfg, candidate=HEAD):
    return {c['id']: {'name': c['name'], 'required': c['required'], 'candidate': candidate, 'ok': True, 'detail': {}} for c in cfg['checks']}


CFG = json.loads((ROOT / 'configs/release-checks.yaml').read_text())


def test_every_required_check_passing_on_the_candidate_releases(tmp_path):
    ok, d = decide_with(tmp_path, all_passed(CFG))
    assert ok and d['outcome'] == 'RELEASE' and d['reasons'] == [] and 'not a full replication' in d['scope']


def test_one_failed_required_check_blocks_with_a_written_reason(tmp_path):
    checks = all_passed(CFG)
    checks['tier2_live_gate']['ok'] = False
    ok, d = decide_with(tmp_path, checks)
    assert not ok and d['outcome'] == 'BLOCKED' and any(r.startswith('tier2_live_gate: failed') for r in d['reasons'])


def test_a_check_recorded_for_another_commit_or_missing_does_not_count(tmp_path):
    checks = all_passed(CFG)
    checks['offline_reproduction']['candidate'] = '0' * 40
    del checks['readme_fresh']
    ok, d = decide_with(tmp_path, checks)
    assert not ok and any('offline_reproduction: recorded for' in r for r in d['reasons']) and any(r == 'readme_fresh: not run' for r in d['reasons'])


def test_code_changed_after_the_candidate_blocks(tmp_path):
    older = subprocess.run(['git', 'log', '--format=%H', '-n', '1', 'HEAD~5', '--', 'scripts/'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    ok, d = decide_with(tmp_path, all_passed(CFG, older), candidate=older)
    assert not ok and any('changed after the candidate' in r for r in d['reasons'])
