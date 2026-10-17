"""TB-043: the related-work matrix check rejects a row without a source or a specific limitation, a dangling basis, and a
misquoted TrustBench number; the committed CSV is current."""
import copy, runpy, subprocess, sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / 'scripts/build-related-work.py'


def problems_with(mutate):
    ns = runpy.run_path(str(BUILD), run_name='checker')
    rows = copy.deepcopy(ns['ROWS'])
    mutate(rows)
    ns['problems'].__globals__['ROWS'] = rows
    return ns['problems']()


def test_committed_matrix_passes_and_is_current():
    p = subprocess.run([sys.executable, str(BUILD), '--check'], capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr


@pytest.mark.parametrize('label,mutate,expect', [
    ('no limitation', lambda rows: rows[0].update(specific_limitation=''), 'missing specific_limitation'),
    ('vague limitation', lambda rows: rows[0].update(specific_limitation='Has limits.'), 'limitation is not specific'),
    ('no source', lambda rows: rows[0].update(source_url=''), 'missing source_url'),
    ('secondary source', lambda rows: rows[0].update(source_url='https://example.com/review'), 'not a primary listing'),
    ('dangling basis', lambda rows: rows[0].update(limitation_basis='reported_by_later_work:RW99'), 'unknown row RW99'),
    ('another system\'s numbers', lambda rows: next(r for r in rows if r['id'] == 'RW10').update(trustbench_measurement='spotlighting attacker goal 10/18 (56%; 34%–75%)'), 'not on the spotlighting row'),
    ('misquoted number', lambda rows: next(r for r in rows if r['trustbench_measurement']).update(trustbench_measurement='attacker goal 7/18 (39%; 1%–2%)'), 'not found in'),
])
def test_the_check_rejects_a_bad_row(label, mutate, expect):
    assert any(expect in p for p in problems_with(mutate)), label
