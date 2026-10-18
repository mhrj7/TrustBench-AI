"""TB-052: résumé bullets use only measured, referenced numbers and no ranking or hiring claim."""
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEXT = (ROOT / 'portfolio/bullets.md').read_text()
LEDGER = json.loads((ROOT / 'portfolio/bullets-claims.json').read_text())


def bullets():
    return [b for b in re.split(r'\n(?=- \*\*Problem:)', TEXT.split('## Bullets', 1)[1].split('## Not included', 1)[0]) if b.strip().startswith('- **Problem')]


def test_every_bullet_states_problem_action_and_result():
    assert len(bullets()) >= 4
    for b in bullets():
        assert '**Problem:**' in b and '**Action:**' in b and '**Result:**' in b


def test_every_number_is_listed_with_its_source_in_the_claim_table():
    table = TEXT.split('## Claim-to-evidence table', 1)[1]
    assert len(LEDGER['items']) == LEDGER['claims'] and LEDGER['claims'] > 0
    for c in LEDGER['items']:
        assert f"| {c['rendered']} | [`{c['source']}`]" in table, c
        assert (ROOT / c['source']).exists()


def test_the_required_qualifiers_accompany_the_headline_results():
    first = bullets()[0]
    assert 'holdout-1 on its own was not separated' in first and 'static' in first and 'one free model' in first
    assert 'AI reviewers only' in bullets()[1]
    assert "not the authors' systems" in bullets()[2]


def test_no_ranking_percentile_or_hiring_claim():
    assert not re.search(r'top[- ]?\d+ ?%|top (one|1) percent|guaranteed (job|hire|hiring|interview|offer)|world[- ]class|industry[- ]leading', TEXT, re.I)
