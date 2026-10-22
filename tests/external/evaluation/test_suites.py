"""TB-064: the external suites are what the builder makes from the frozen split, and never mix assignments."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / 'tests/external/evaluation'


def test_suites_are_current():
    r = subprocess.run([sys.executable, str(ROOT / 'scripts/build-external-validation-suite.py'), '--check'], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_each_suite_holds_only_its_assignment():
    split = {f['family_id']: f['assignment'] for f in json.loads((ROOT / 'data/external-splits.json').read_text())['families']}
    for name, assignment in [('external-validation-benign.json', 'external_validation'), ('external-validation-attack.json', 'external_validation'), ('external-tuning.json', 'tuning')]:
        s = json.loads((HERE / name).read_text())
        assert s['assignment'] == assignment and s['cases']
        assert all(split[c['family_id']] == assignment for c in s['cases']), name
    ev = {c['family_id'] for n in ('external-validation-benign.json', 'external-validation-attack.json') for c in json.loads((HERE / n).read_text())['cases']}
    assert ev == {f for f, a in split.items() if a == 'external_validation'}


def test_registry_points_at_the_suites():
    ext = json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())['external_validation']
    assert all((ROOT / p).exists() for p in ext['suites'].values())
    assert {r['rendering'] for r in ext['runs'] if r['suite'] == 'attack'} == {ext['renderings']['primary'], *ext['renderings']['secondary'], ext['renderings']['positive_control']}
