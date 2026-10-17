"""TB-035: the cost ledger and latency table reproduce from the trace exporter, include failed attempts, and never compare
latency across concurrency levels."""
import importlib.util, json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('cost_latency', ROOT / 'scripts/measure-cost-latency.py')
cl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cl)
META = json.loads((ROOT / cl.CFG['outputs']['json']).read_text())


def test_ledger_has_every_model_call_attempt_including_failed_ones():
    ledger = pd.read_csv(ROOT / cl.CFG['outputs']['ledger'])
    for name, path in cl.CFG['workloads'].items():
        _, runs, calls, _ = cl.load_workload(name, path)
        sub = ledger[ledger['workload'] == name]
        assert len(sub) == len(calls)
        assert (sub['status'] != 'ok').sum() == sum(c['status'] != 'ok' for c in calls)


def test_every_reported_run_has_a_root_span_and_a_concurrency_level():
    for name, path in cl.CFG['workloads'].items():
        _, runs, _, pairs = cl.load_workload(name, path)
        assert len(runs) == 2 * len(pairs)
        assert all(0 <= r['concurrency_level'] <= META['settings']['concurrency']['observed'][name]['max_concurrent_runs'] - 1 for r in runs.values())


def test_latency_comparisons_stay_within_one_concurrency_level():
    for c in META['latency_comparisons']:
        if c['concurrency_level'] == 'arms differ':
            assert c['matched_pairs'] == 0 and c['excluded_pairs'] > 0
        else:
            assert isinstance(c['concurrency_level'], int) and c['matched_pairs'] > 0


def test_settings_record_concurrency_price_date_and_retries():
    s = META['settings']
    assert s['provider_price']['verified_at'] and s['provider_price']['source_url']
    assert s['retry']['max_attempts_per_call'] == json.loads((ROOT / cl.HC['reliability']['override_file']).read_text())['retry']['max_attempts_per_call']
    assert set(s['concurrency']['observed']) == set(cl.CFG['workloads'])


def test_cost_per_successful_task_is_undefined_not_zero_without_successes():
    rows = pd.read_csv(ROOT / cl.CFG['outputs']['csv'])
    none = rows[rows['successful_tasks'] == 0]
    assert none['usd_per_successful_task'].isna().all() and none['tokens_per_successful_task'].isna().all()
    assert cl.usd(1_000_000, 1_000_000) == cl.PRICE['input_usd_per_million_tokens'] + cl.PRICE['output_usd_per_million_tokens']


def test_published_table_reproduces():
    rows, comps = [], []
    for name, path in cl.CFG['workloads'].items():
        _, runs, calls, pairs = cl.load_workload(name, path)
        r, c = cl.summarise(name, runs, calls, pairs)
        rows += r; comps += c
    published = pd.read_csv(ROOT / cl.CFG['outputs']['csv'])
    fresh = pd.DataFrame(rows)
    assert len(published) == len(fresh)
    assert (published['agent_input_tokens'].to_list(), published['runs'].to_list()) == (fresh['agent_input_tokens'].to_list(), fresh['runs'].to_list())
    assert comps == META['latency_comparisons']
