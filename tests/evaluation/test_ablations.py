"""TB-036 (A-027): ablation analysis logic, tested on development reports already seen."""
import copy, importlib.util, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ablations', ROOT / 'scripts/analyse-ablations.py')
ab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ab)
GATE = json.loads((ROOT / json.loads((ROOT / 'evidence/release-gate-dev.json').read_text())['report']).read_text())
UNSAFE = ab.ENDPOINTS['unsafe_committed_effect']


def test_an_arm_compared_with_itself_has_zero_difference():
    x = ab.between(GATE, GATE, UNSAFE)
    assert x['point'] == 0 and x['cluster_bootstrap95'] == [0.0, 0.0] and x['matched_units'] > 0


def test_removing_a_protective_component_shows_as_credited():
    worse = copy.deepcopy(GATE)
    for c in worse['cases']:
        if c['kind'] == 'attack':
            c['defended']['evaluation'] = c['baseline']['evaluation']  # 'without' arm: no protection at all
    sec = ab.between(GATE, worse, UNSAFE)
    util = ab.between(GATE, worse, ab.ENDPOINTS['benign_utility_pass'])
    assert sec['cluster_bootstrap95'][1] < 0
    assert ab.reading(sec, util)[0].startswith('credited')


def test_reading_reports_null_and_harmful_results_honestly():
    null = {'cluster_bootstrap95': [-0.2, 0.1]}
    assert ab.reading(null, null) == ('no measurable contribution on development data', 'no measurable utility effect')
    assert ab.reading({'cluster_bootstrap95': [0.05, 0.3]}, {'cluster_bootstrap95': [-0.4, -0.1]}) == ('harmful: it raises unsafe effects', 'utility cost')


def test_every_claim_is_tested_or_labelled_untested_with_a_reason():
    ids = {c['id'] for c in ab.AB['comparisons']}
    for cl in ab.AB['claims']:
        assert set(cl['tested_by']) <= ids
        assert cl['tested_by'] or cl.get('untested_reason')
    assert {c['with'] for c in ab.AB['comparisons']} | {c['without'] for c in ab.AB['comparisons']} - {'baseline'} <= set(ab.AB['run']['arms_to_run']) | {ab.AB['run']['frozen_arm']['system']}
