"""TB-059: the external agent's development suite covers every development fixture and nothing sealed."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from src.arms.fixtures import materialize, sealed_fixture_ids  # noqa: E402

SPLITS = json.loads((ROOT / 'data/splits.json').read_text())
DEV = {f for g in SPLITS['groups'] if g['split'] == 'tuning' for f in g['fixture_ids']}
SUITE = json.loads((ROOT / 'tests/external/fixtures/dev-suite.json').read_text())


def ids(case):
    return {x for x in (case['fixture_id'].split('--')[0], case.get('attack_id')) if x}


def test_suite_is_current():
    assert subprocess.run([sys.executable, 'scripts/build-external-dev-suite.py', '--check'], cwd=ROOT).returncode == 0


def test_every_development_fixture_has_a_case_and_nothing_else():
    covered = set().union(*(ids(c) for c in SUITE['cases']))
    assert covered == DEV
    assert set(SUITE['development_fixture_ids']) == DEV


def test_no_sealed_fixture_in_the_suite():
    sealed = sealed_fixture_ids()
    assert sealed and not any(ids(c) & sealed for c in SUITE['cases'])


def test_generated_cases_follow_their_oracle():
    benign = {json.loads(l)['fixture_id']: json.loads(l) for l in (ROOT / 'data/benign.jsonl').read_text().splitlines() if l.strip()}
    generated = [c for c in SUITE['cases'] if c.get('generated_from_oracle')]
    assert generated
    for c in generated:
        oracle = benign[c['fixture_id']]['oracle']
        last = c['steps'][-1]['arguments']
        if oracle['kind'] == 'research_note':
            assert all(last[k] == oracle[k] for k in ('note_id', 'answer', 'citation_document_ids', 'abstained'))
        else:
            assert all(fragment in last['body'] for fragment in oracle['required_body_fragments'])


def test_development_materialization_loads_no_sealed_fixture():
    fixtures, info = materialize(exclude_sealed=True)
    sealed = sealed_fixture_ids()
    loaded = {part for f in fixtures for part in f['fixture_id'].split('--')}
    assert not loaded & sealed and not set(info) & sealed
    assert {f['fixture_id'].split('--')[-1] if '--' in f['fixture_id'] else f['fixture_id'] for f in fixtures} == DEV
    everything, _ = materialize()
    assert {part for f in everything for part in f['fixture_id'].split('--')} & sealed, 'positive control: without the exclusion sealed fixtures are present'
