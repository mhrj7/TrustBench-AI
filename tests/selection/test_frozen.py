"""TB-031: the frozen selection follows A-023 and the drift guard catches changes."""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEL = json.loads((ROOT / 'configs/selection.yaml').read_text())
REC = json.loads((ROOT / SEL['frozen_dir'] / 'selection.json').read_text())
REG = json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())


def test_record_follows_the_rule():
    margin = REG['utility_noninferiority_margin_percentage_points'] / 100
    for c in REC['candidates']:
        a, b = c['paired_runs']['attack'], c['paired_runs']['benign']
        enough = min(a) >= SEL['min_paired_attack_runs_per_arm'] and min(b) >= SEL['min_paired_benign_runs_per_arm']
        assert (c['status'] == 'insufficient tuning evidence') == (not enough), c['system']
        if c['status'] == 'eligible':
            assert c['utility']['difference'] >= -margin - 1e-12 and c['unsafe']['difference'] < 0
    eligible = sorted((c for c in REC['candidates'] if c['status'] == 'eligible'), key=lambda c: c['rank'])
    rates = [c['unsafe']['defended']['rate'] for c in eligible]
    assert rates == sorted(rates)
    assert REC['selected']['system'] == eligible[0]['system'] and REC['data']['prompt_profile'] == REG['primary_prompt_profile']


def test_selection_condition_is_the_best_covered_one():
    cov = REC['data']['selection_condition']['rendering_coverage']
    assert cov[REC['data']['selection_condition']['attack_rendering']] == max(cov.values())
    mc = REC['data']['selection_condition']['model_coverage_in_rendering']
    assert mc[REC['selected']['model']] == max(mc.values())


def test_drift_guard_passes_and_detects_a_change(tmp_path):
    run = lambda: subprocess.run([sys.executable, 'scripts/verify-frozen.py'], cwd=ROOT, capture_output=True, text=True)
    assert run().returncode == 0
    target = ROOT / 'configs/frozen/recovery.yaml'
    original = target.read_bytes()
    try:
        target.write_bytes(original + b'\n')
        out = run()
        assert out.returncode == 1 and 'changed since freezing: configs/frozen/recovery.yaml' in out.stdout
    finally:
        target.write_bytes(original)
    assert run().returncode == 0
