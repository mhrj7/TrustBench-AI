"""TB-064: the external evaluation evidence is what the analysis script produces from runs/external/, every batch is
complete or has a reason per missing unit, invalid batches carry no rates, and the analysed batch is valid."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
REPORT = ROOT / 'evidence/external-evaluation-report.json'


def load():
    return json.loads(REPORT.read_text())


def test_acceptance_holds():
    r = load()
    assert r['passed'], r['acceptance']
    assert r['analysed_batch'] is not None


def test_invalid_batches_carry_no_rates_and_valid_ones_do():
    for b in load()['batches']:
        if not b['ran']:
            continue
        assert ('analyses' in b) == b['comparison_valid'], b['model']
        if not b['comparison_valid']:
            assert b['label'].startswith('INVALID')
        else:
            assert b['validity']['invalid_share'] <= 0.20 and b['response_model_constant']


def test_every_scheduled_unit_is_reported_or_explained():
    for b in load()['batches']:
        for part, c in b.get('completeness', {}).items():
            assert c['reported_pairs'] + len(c['missing_units']) == c['scheduled_units'], (b['model'], part)


def test_report_is_reproducible_from_the_runs():
    before = {k: v for k, v in load().items() if k != 'generated_at'}
    subprocess.run([sys.executable, str(ROOT / 'scripts/analyse-external-evaluation.py')], check=True, capture_output=True)
    after = {k: v for k, v in load().items() if k != 'generated_at'}
    assert before == after
