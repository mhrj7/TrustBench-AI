"""TB-047: every numeric claim in the technical report maps to a stored artifact."""
import hashlib, json, re, runpy, subprocess, sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/build-report.py'
NS = runpy.run_path(str(SCRIPT), run_name='report')
CFG = NS['CFG']
LEDGER = json.loads((ROOT / CFG['claims']).read_text())


def test_the_committed_report_and_ledger_are_what_the_artifacts_produce():
    p = subprocess.run([sys.executable, str(SCRIPT), '--check'], cwd=ROOT, capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr


def test_every_number_in_the_rendered_report_is_covered_by_a_claim_on_its_line():
    # Independent of the template lint: scan the output itself. Identifiers (task, amendment and source IDs, holdout names,
    # dates, model and version names), code spans and link targets are not claims.
    by_line = {}
    for c in LEDGER['items']:
        by_line.setdefault(c['report_line'], []).append(c['rendered'])
    allowed = [re.compile(p) for p in CFG['allowed_identifier_patterns']]
    for n, line in enumerate((ROOT / CFG['report']).read_text().splitlines(), 1):
        text = re.sub(r'`[^`]*`', ' ', line)
        text = re.sub(r'\]\([^)]*\)', ']', text)
        for rendered in sorted(by_line.get(n, []), key=len, reverse=True):
            text = text.replace(rendered, ' ', 1)
        for rx in allowed:
            text = rx.sub(' ', text)
        assert not re.search(r'\d', text), f'report line {n} has a number no claim accounts for: {line.strip()[:140]}'


def test_every_claim_source_is_a_committed_file_with_the_recorded_hash():
    tracked = set(subprocess.run(['git', 'ls-files'], cwd=ROOT, capture_output=True, text=True).stdout.split())
    for src, digest in LEDGER['sources_sha256'].items():
        assert src in tracked, src
        assert hashlib.sha256((ROOT / src).read_bytes()).hexdigest() == digest, src


def test_every_claim_re_resolves_to_its_recorded_value():
    for c in LEDGER['items']:
        alias = next(a for a, s in CFG['sources'].items() if s['file'] == c['source'])
        assert NS['fmt'](NS['resolve'](NS['load'](alias), c['path']), c['format']) == c['rendered'], c


@pytest.mark.parametrize('text,problem', [
    ('The rate fell by 40 points.', 'literal digit'),
    ('It ran three times.', 'number word'),
    ('This result is state of the art.', 'forbidden'),
    ('See [`nope.md`](missing/nope.md).', 'does not exist'),
])
def test_the_lint_rejects_unsourced_numbers_overclaims_and_dead_links(text, problem):
    assert any(problem in p for p in NS['lint'](text))


def test_the_lint_accepts_identifiers_and_placeholders():
    assert NS['lint']('TB-045 and A-029 on holdout-2 (RW07, M5) gave {{h:primary.verdict|raw}} on 2026-10-18.') == []


def test_the_report_states_its_status_and_limits():
    text = (ROOT / CFG['report']).read_text()
    assert 'not been peer reviewed' in text
    for heading in ('## Problem', '## Threat model', '## Experimental design', '## Results', '## Failure cases', '## Limits'):
        assert heading in text
