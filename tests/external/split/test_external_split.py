"""TB-061: the registered external-validation split procedure (scripts/external-split.py, amendment A-030), tested on
placeholder family lists: deterministic for its seed, stratified, excludes the core holdout and every tuning-used family,
and refuses to reassign a family once assigned."""
import importlib.util
import json
import math
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('external_split', ROOT / 'scripts/external-split.py')
xs = importlib.util.module_from_spec(spec); spec.loader.exec_module(xs)
SPLITS = json.loads((ROOT / 'data/splits.json').read_text())
REG = xs.registry()
WF = xs.WORKFLOWS


def placeholders(n_per_wf=4, prefix='family-placeholder'):
    return [{'family_id': f'{prefix}-{w.split("_")[0]}-{i}', 'workflow': w, 'origin': 'new'} for w in WF for i in range(n_per_wf)]


def run(cands, seed=None, fraction=None, existing=None):
    return xs.assign(cands, SPLITS, REG['split_seed'] if seed is None else seed, REG['external_fraction'] if fraction is None else fraction, existing)


def test_registered_parameters_match_the_amendment():
    amendment = (ROOT / 'protocol/amendments.md').read_text()
    assert '## A-030' in amendment and 'scripts/external-split.py' in amendment
    assert REG['amendment'] == 'A-030' and REG['split_seed'] == 2026102201 and REG['external_fraction'] == 0.6
    assert REG['evaluation_runs_started'] is False, 'the procedure must be registered before any external evaluation run'


def test_deterministic_for_its_seed_and_independent_of_input_order():
    a = run(placeholders())
    b = run(list(reversed(placeholders())))
    assert a == b and a['sha256'] == b['sha256']
    other = run(placeholders(), seed=REG['split_seed'] + 1)
    assert [r['family_id'] for r in other['families']] != [r['family_id'] for r in a['families']], 'the order depends on the seed'


def test_stratified_by_workflow_with_the_registered_fraction():
    doc = run(placeholders(n_per_wf=5))
    for w in WF:
        rows = [r for r in doc['families'] if r['workflow'] == w]
        ext = sum(r['assignment'] == 'external_validation' for r in rows)
        assert ext == math.ceil(len(rows) * REG['external_fraction']) and ext >= 1
    single = run([{'family_id': 'family-placeholder-only', 'workflow': WF[0], 'origin': 'new'}])
    assert single['families'][0]['assignment'] == 'external_validation', 'at least one external family per workflow'


def test_every_tuning_used_family_is_refused():
    tuning = sorted(xs.tuning_families(SPLITS))
    assert tuning, 'positive control: the inventory has tuning families'
    for fam in tuning:
        with pytest.raises(xs.SplitError, match='used in tuning'):
            run(placeholders() + [{'family_id': fam, 'workflow': WF[0], 'origin': 'existing'}])


def test_the_core_holdout_is_excluded():
    sealed = sorted(xs.sealed_fixtures(SPLITS))
    core = SPLITS['holdout_manifest']['fixture_ids']
    assert core and set(core) <= set(sealed)
    with pytest.raises(xs.SplitError, match='sealed holdout fixtures'):
        run(placeholders() + [{'family_id': 'family-placeholder-reuse', 'workflow': WF[1], 'origin': 'new', 'fixture_ids': [core[0]]}])
    # A family seen only in a sealed holdout may be used with new fixtures, labelled holdout_seen.
    seen_only = sorted(xs.holdout_families(SPLITS) - xs.tuning_families(SPLITS))
    assert seen_only
    doc = run(placeholders() + [{'family_id': seen_only[0], 'workflow': WF[2], 'origin': 'existing'}])
    assert next(r for r in doc['families'] if r['family_id'] == seen_only[0])['family_status'] == 'holdout_seen'


def test_refuses_to_reassign_a_family_once_assigned():
    first = run(placeholders())
    # Same rule, one family added: old assignments are kept.
    grown = run(placeholders() + [{'family_id': 'family-placeholder-late', 'workflow': WF[0], 'origin': 'new'}], existing=first)
    before = {r['family_id']: r['assignment'] for r in first['families']}
    assert all(before[r['family_id']] == r['assignment'] for r in grown['families'] if r['family_id'] in before)
    # Another seed (which would move assigned families) is refused, as is another fraction.
    moved_seed = next(s for s in range(1, 200) if any(r['assignment'] != before[r['family_id']] for r in run(placeholders(), seed=s)['families']))
    with pytest.raises(xs.SplitError, match='reassign'):
        run(placeholders(), seed=moved_seed, existing=first)
    with pytest.raises(xs.SplitError, match='reassign'):
        run(placeholders(), fraction=0.5, existing=first)
    with pytest.raises(xs.SplitError, match='missing'):
        run(placeholders()[1:], existing=first)


def test_cli_refuses_a_hand_edited_manifest(tmp_path):
    cands = tmp_path / 'families.json'; cands.write_text(json.dumps(placeholders()))
    out = tmp_path / 'external-splits.json'
    cli = [sys.executable, str(ROOT / 'scripts/external-split.py'), '--families', str(cands), '--out', str(out)]
    assert subprocess.run(cli, capture_output=True).returncode == 0
    assert subprocess.run(cli + ['--check'], capture_output=True).returncode == 0
    doc = json.loads(out.read_text())
    doc['families'][0]['assignment'] = 'tuning' if doc['families'][0]['assignment'] == 'external_validation' else 'external_validation'
    out.write_text(json.dumps(doc))
    r = subprocess.run(cli, capture_output=True, text=True)
    assert r.returncode == 1 and 'edited by hand' in r.stderr
