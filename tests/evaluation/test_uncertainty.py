"""TB-034: the seeded analysis reproduces its intervals and resamples whole clusters. Development data only."""
import copy, importlib.util, json
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
GATE = json.loads((ROOT / 'evidence/release-gate-dev.json').read_text())
REPORT = json.loads((ROOT / GATE['report']).read_text())
spec = importlib.util.spec_from_file_location('uncertainty', ROOT / 'scripts/estimate-uncertainty.py')
un = importlib.util.module_from_spec(spec)
spec.loader.exec_module(un)


def test_seeded_analysis_reproduces_every_interval():
    assert un.analyse('dev', [REPORT], 'test') == un.analyse('dev', [copy.deepcopy(REPORT)], 'test')


def test_bootstrap_resamples_whole_clusters_with_their_repetitions():
    """Reference implementation: draw clusters with replacement, pool all their pairs, take the mean."""
    by = {('t1', 'a'): [1.0, 1.0, 1.0], ('t2', 'b'): [0.0, 0.0, 0.0, 0.0, 0.0], ('t3', 'c'): [1.0, 0.0], ('t4', 'd'): [-1.0]}
    keys = sorted(by)
    rng = np.random.default_rng(un.SEED)
    idx = rng.integers(0, len(keys), size=(un.B, len(keys)))
    dist = np.array([np.mean([x for i in row for x in by[keys[i]]]) for row in idx])
    expected = [round(float(np.quantile(dist, 0.025)), 4), round(float(np.quantile(dist, 0.975)), 4)]
    assert un.cluster_bootstrap(by) == expected
    # A pair-level (iid) bootstrap would ignore the clustering; here clusters of identical outcomes widen the interval.
    flat = [x for v in by.values() for x in v]
    iid = np.random.default_rng(un.SEED).choice(flat, size=(un.B, len(flat))).mean(axis=1)
    assert expected[1] - expected[0] > float(np.quantile(iid, 0.975) - np.quantile(iid, 0.025))


def test_gate_tolerance_is_reproduced_by_the_tb034_bootstrap_definition():
    """Same estimator as the A-025 gate (cluster-resampled pooled mean); only the registered seed offset differs."""
    e = un.analyse('dev', [REPORT], 'test')['endpoints']['unsafe_committed_effect']
    t1 = GATE['tolerances']['T1_unsafe_committed_effect']
    assert e['paired_difference']['point'] == t1['point']
    assert e['clusters'] == t1['clusters'] and e['pairs'] == t1['pairs']


def test_zero_observed_gets_a_one_sided_bound_not_a_zero():
    assert un.zero_bound(0, 15) == round(1 - 0.05 ** (1 / 15), 4)
    assert un.zero_bound(1, 15) is None and un.zero_bound(0, 0) is None


def test_mcnemar_counts_discordant_pairs():
    e = un.analyse('dev', [REPORT], 'test')['endpoints']['unsafe_committed_effect']
    rows = [c for c in REPORT['cases'] if c['kind'] == 'attack' and not c['baseline']['invalid'] and not c['defended']['invalid']]
    b = sum(not c['baseline']['evaluation']['security_pass'] and c['defended']['evaluation']['security_pass'] for c in rows)
    assert e['mcnemar_exact']['baseline_only'] == b


def test_repeatability_block_comes_from_the_tb028_evaluator():
    a = un.analyse('dev', [REPORT], 'test')
    sec = next(iter(a['repeatability'].values()))['attack_security']
    assert {'baseline', 'defended'} == set(sec['arms']) and 'intra_cluster_correlation' in sec['arms']['defended']


def test_published_uncertainty_reproduces_from_the_hashed_reports():
    """TB-034 acceptance: rerunning the seeded analysis reproduces every published interval."""
    published = json.loads((ROOT / un.CFG['outputs']['json']).read_text())
    assert published['bootstrap']['seed'] == un.SEED and published['bootstrap']['resamples'] == un.B
    fresh = {a['analysis']: a for a in un.analyse_all()}
    for a in published['analyses']:
        assert fresh[a['analysis']]['endpoints'] == a['endpoints'], a['analysis']
