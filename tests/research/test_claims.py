"""TB-048: no novelty, security-guarantee, publication or résumé claim in the public text exceeds the evidence."""
import csv, json, re, runpy, subprocess, sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/check-claims.py'
CFG = json.loads((ROOT / 'configs/claims.yaml').read_text())


def run():
    return subprocess.run([sys.executable, str(SCRIPT)], cwd=ROOT, capture_output=True, text=True)


def test_the_public_text_passes_the_claim_check():
    p = run()
    assert p.returncode == 0, p.stdout


@pytest.mark.parametrize('kind,text', [
    ('novelty', 'TrustBench is a novel defense.'), ('novelty', 'The first ever gateway of its kind.'),
    ('guarantee', 'The gateway guarantees safety.'), ('guarantee', 'It blocks all prompt injections.'),
    ('guarantee', 'The tests prove the system is secure.'), ('publication', 'A patent is pending.'),
    ('resume', 'Results put this in the top 1% of projects.'),
])
def test_each_pattern_family_catches_its_overclaim(kind, text):
    assert re.search('|'.join(f'(?:{p})' for p in CFG['patterns'][kind]), text, re.I)


def test_ordinary_test_language_is_not_flagged_as_a_security_claim():
    pats = '|'.join(f'(?:{p})' for k in CFG['patterns'] for p in CFG['patterns'][k])
    assert not re.search(pats, 'an executable forced-exhaustion check proves that pending work is cancelled', re.I)


def test_a_new_unreviewed_overclaim_fails_the_check(tmp_path):
    planted = ROOT / 'docs/zz-claims-check-probe.md'
    planted.write_text('# Probe\n\nTrustBench guarantees security against prompt injection.\n')
    try:
        p = run()
        assert p.returncode == 1 and 'zz-claims-check-probe.md' in p.stdout
    finally:
        planted.unlink()
        run()  # rewrite research/claims-check.json for the real tree


def test_portfolio_numbers_must_come_from_a_claim_ledger():
    folder = ROOT / 'portfolio'
    created = not folder.exists()
    folder.mkdir(exist_ok=True)
    probe = folder / 'zz-probe.md'
    try:
        ledger = json.loads((ROOT / 'research/claims-ledger.json').read_text())
        sourced = next(c['rendered'] for c in ledger['items'] if re.search(r'\d', c['rendered']))
        probe.write_text(f'- Measured {sourced} on the primary analysis.\n')
        assert run().returncode == 0
        probe.write_text('- Cut attacks by 97%.\n')
        p = run()
        assert p.returncode == 1 and 'not in a claim ledger' in p.stdout
    finally:
        probe.unlink()
        if created:
            folder.rmdir()
        run()


def test_every_prior_work_id_in_the_register_exists_in_the_matrix():
    ids = {r['id'] for r in csv.DictReader(open(ROOT / 'research/related-work.csv'))}
    cited = set(re.findall(r'\bRW\d+\b', (ROOT / 'research/claims.md').read_text()))
    assert cited and cited <= ids


def test_the_register_separates_the_required_categories():
    text = (ROOT / 'research/claims.md').read_text()
    for heading in ('## Replicated or adapted from prior work', '## Engineering contributions', '## Hypotheses that need more evidence', '## Not claimed'):
        assert heading in text


def test_every_allow_entry_has_a_reason():
    assert all(a['reason'].strip() for a in CFG['allow'])
