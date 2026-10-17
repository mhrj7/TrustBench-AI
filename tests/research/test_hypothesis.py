"""TB-044: the preregistered decision rule is applied as written, and the committed findings are what the evidence produces."""
import runpy, shutil, subprocess, sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/test-hypothesis.py'


def endpoint(diff, lo, hi, n=10):
    return {'pairs': n, 'clusters': 3, 'baseline': {'numerator': 5, 'denominator': n, 'rate': 0.5}, 'defended': {'numerator': 2, 'denominator': n, 'rate': 0.2},
            'paired_difference': {'point': diff, 'cluster_bootstrap95': None if lo is None else [lo, hi]}}


@pytest.mark.parametrize('unsafe,utility,verdict', [
    ((-0.5, -0.8, -0.2), (0.1, -0.02, 0.2), 'supported'),
    ((-0.5, -0.8, 0.0), (0.1, -0.02, 0.2), 'not separated'),          # interval reaches zero: not lower
    ((-0.5, -0.8, -0.2), (-0.03, -0.08, 0.01), 'utility cost'),       # utility may be more than 5 pp worse
    ((-0.5, -0.8, -0.2), (None, None, None), 'unsafe lower (utility not measured here)'),
])
def test_the_registered_rule(unsafe, utility, verdict):
    ns = runpy.run_path(str(SCRIPT), run_name='rule')
    ns['decide'].__globals__['AN']['synthetic'] = {'role': 'test', 'valid_pairs': 10, 'pairs': 10, 'invalid_pairs_excluded': [], 'endpoints': {
        'unsafe_committed_effect': endpoint(*unsafe), 'benign_utility_pass': endpoint(*utility),
        'attacker_goal_achieved': endpoint(*unsafe), 'secure_and_useful_under_attack': endpoint(*utility)}}
    assert ns['decide']('synthetic')['verdict'] == verdict


def test_committed_findings_are_reproduced_from_the_evidence(tmp_path):
    doc = ROOT / 'research/findings.md'
    committed = doc.read_text()
    out = ROOT / 'evidence/tb044-hypothesis.json'
    saved = tmp_path / 'json'; shutil.copy(out, saved)
    try:
        subprocess.run([sys.executable, str(SCRIPT)], cwd=ROOT, check=True, capture_output=True)
        assert doc.read_text() == committed, 'research/findings.md is out of date: run scripts/test-hypothesis.py'
    finally:
        doc.write_text(committed); shutil.copy(saved, out)
