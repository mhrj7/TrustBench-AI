#!/usr/bin/env python3
"""TB-035: latency and operating cost of the confirmatory workloads, from the TB-027 trace exporter.

Reads every run's spans (agent.run root spans and model.call spans) for each workload in configs/cost-latency.yaml,
checks they cover every reported pair, and writes:
  - a cost ledger, one row per model-call attempt including failed attempts, priced from the frozen budget pricing block;
  - per workload, rendering, kind, arm and concurrency level: p50/p95 end-to-end time (queueing included), tokens
    (agent and defense classifier), model-call attempts, retries, billed cost, successes and cost per successful task;
  - paired defended-minus-baseline latency, only over pairs whose two arms ran at the same concurrency level, with a
    cluster-bootstrap interval;
  - the settings record the comparison depends on: concurrency, provider price and its date, retry and rate settings."""
import importlib.util, json, sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'configs/cost-latency.yaml').read_text())
HC = json.loads((ROOT / 'configs/frozen/holdout-config.json').read_text())
_spec = importlib.util.spec_from_file_location('uncertainty', ROOT / 'scripts/estimate-uncertainty.py')
UN = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(UN)

BUDGET = json.loads((ROOT / HC['runtime_settings'][HC['provider_entry']['budget_file']]).read_text())
PRICE = BUDGET['pricing']
RECOVERY = json.loads((ROOT / HC['runtime_settings']['configs/recovery.yaml']).read_text())
OVERRIDE = json.loads((ROOT / HC['reliability']['override_file']).read_text())
LIVE = json.loads((ROOT / HC['runtime_settings']['configs/live-run.yaml']).read_text())['live']
PACE = json.loads((ROOT / HC['runtime_settings']['configs/live-matrix.yaml']).read_text())['models'][HC['model']]
SUCCESS = {'benign': lambda e: bool(e['utility_pass']), 'attack': lambda e: bool(e['security_pass']) and bool(e['utility_pass'])}


def usd(input_tokens, output_tokens):
    return (input_tokens * PRICE['input_usd_per_million_tokens'] + output_tokens * PRICE['output_usd_per_million_tokens']) / 1e6


def load_workload(name, record_path):
    rec = json.loads((ROOT / record_path).read_text())
    if not rec['complete']:
        sys.exit(f'{record_path} is not complete')
    runs, calls, pairs = {}, [], []
    for unit in rec['renderings']:
        report = json.loads((ROOT / unit['report']).read_text())
        label = f"{unit.get('suite') + '/' if unit.get('suite') else ''}{unit['rendering']}"
        for c in report['cases']:
            pairs.append((label, unit['rendering'], c))
        for line in (ROOT / report['trace_file']).read_text().splitlines():
            s = json.loads(line)
            a = s['attributes']
            if s['name'] == 'agent.run':
                runs[(label, a['run.id'])] = {'start': s['start_ms'], 'end': s['end_ms'], 'elapsed_ms': a['run.elapsed_ms'], 'queue_ms': a['run.queue_ms_total'],
                                              'retry_backoff_ms': a['run.retry_backoff_ms'], 'attempts_total': a['run.attempts_total'], 'model_calls': a['run.model_calls']}
            elif s['name'] == 'model.call':
                calls.append({'workload': name, 'unit': label, 'run_id': a['run.id'], 'request_id': a['model.request_id'], 'role': a['model.role'], 'status': s['status'],
                              'error_code': a.get('error.code'), 'duration_ms': round(s['duration_ms'], 1), 'queue_ms': a['queue.ms'],
                              'input_tokens': a.get('model.input_tokens', 0), 'output_tokens': a.get('model.output_tokens', 0)})
    expected = {(label, f"run-{c['case_id']}-r{c['repetition']}:{arm}") for label, _, c in pairs for arm in ('baseline', 'defended')}
    missing = expected - set(runs)
    if missing:
        sys.exit(f'{name}: {len(missing)} reported runs have no agent.run span, e.g. {sorted(missing)[:3]}')
    # Concurrency: time-weighted number of other runs of this workload in progress during each run.
    intervals = sorted((r['start'], r['end'], k) for k, r in runs.items())
    for k, r in runs.items():
        span = max(r['end'] - r['start'], 1e-9)
        overlap = sum(max(0.0, min(r['end'], e) - max(r['start'], s)) for s, e, other in intervals if other != k)
        r['concurrency_mean'] = round(overlap / span, 3)
        r['concurrency_level'] = int(round(overlap / span))
    for c in calls:
        c['usd'] = usd(c['input_tokens'], c['output_tokens'])
    return rec, runs, calls, pairs


def pct(values):
    return {f'p{q}': round(float(np.percentile(values, q)), 1) if values else None for q in CFG['percentiles']}


def summarise(name, runs, calls, pairs):
    by_run_calls = defaultdict(list)
    for c in calls:
        by_run_calls[(c['unit'], c['run_id'])].append(c)
    rows, paired = [], defaultdict(lambda: defaultdict(list))
    groups = defaultdict(list)
    for label, rendering, c in pairs:
        for arm in ('baseline', 'defended'):
            key = (label, f"run-{c['case_id']}-r{c['repetition']}:{arm}")
            r, cs = runs[key], by_run_calls[key]
            groups[(label, c['kind'], arm, r['concurrency_level'])].append({
                'elapsed_ms': r['elapsed_ms'], 'queue_ms': r['queue_ms'], 'concurrency_mean': r['concurrency_mean'], 'invalid': c[arm]['invalid'],
                'success': (not c[arm]['invalid']) and SUCCESS[c['kind']](c[arm]['evaluation']),
                'agent_in': sum(x['input_tokens'] for x in cs if x['role'] == 'agent'), 'agent_out': sum(x['output_tokens'] for x in cs if x['role'] == 'agent'),
                'defense_in': sum(x['input_tokens'] for x in cs if x['role'] != 'agent'), 'defense_out': sum(x['output_tokens'] for x in cs if x['role'] != 'agent'),
                'attempts': len(cs), 'failed_attempts': sum(x['status'] != 'ok' for x in cs), 'usd': sum(x['usd'] for x in cs),
                'retry_backoff_ms': r['retry_backoff_ms']})
        b, d = (runs[(label, f"run-{c['case_id']}-r{c['repetition']}:{arm}")] for arm in ('baseline', 'defended'))
        if not c['baseline']['invalid'] and not c['defended']['invalid']:
            matched = b['concurrency_level'] == d['concurrency_level']
            paired[(label, c['kind'])]['matched' if matched else 'unmatched'].append((UN.cluster_of(c), d['elapsed_ms'] - b['elapsed_ms'], b['concurrency_level']))
    for (label, kind, arm, level), xs in sorted(groups.items()):
        succ = sum(x['success'] for x in xs)
        total_tokens = sum(x['agent_in'] + x['agent_out'] + x['defense_in'] + x['defense_out'] for x in xs)
        total_usd = sum(x['usd'] for x in xs)
        rows.append({'workload': name, 'unit': label, 'kind': kind, 'arm': arm, 'concurrency_level': level, 'runs': len(xs), 'invalid_runs': sum(x['invalid'] for x in xs),
                     'elapsed_p50_ms': pct([x['elapsed_ms'] for x in xs])['p50'], 'elapsed_p95_ms': pct([x['elapsed_ms'] for x in xs])['p95'],
                     'queue_ms_total': round(sum(x['queue_ms'] for x in xs), 1), 'mean_concurrency': round(float(np.mean([x['concurrency_mean'] for x in xs])), 3),
                     'agent_input_tokens': sum(x['agent_in'] for x in xs), 'agent_output_tokens': sum(x['agent_out'] for x in xs),
                     'defense_input_tokens': sum(x['defense_in'] for x in xs), 'defense_output_tokens': sum(x['defense_out'] for x in xs),
                     'model_call_attempts': sum(x['attempts'] for x in xs), 'failed_model_call_attempts': sum(x['failed_attempts'] for x in xs),
                     'retry_backoff_ms_total': round(sum(x['retry_backoff_ms'] for x in xs), 1),
                     'billed_usd': round(total_usd, 6), 'successful_tasks': succ, 'success_definition': CFG['success'][kind],
                     'tokens_per_successful_task': round(total_tokens / succ, 1) if succ else None,
                     'usd_per_successful_task': round(total_usd / succ, 6) if succ else None,
                     'price_verified_at': PRICE['verified_at']})
    comparisons = []
    for (label, kind), d in sorted(paired.items()):
        by_level = defaultdict(lambda: defaultdict(list))
        for cluster, diff, level in d['matched']:
            by_level[level][cluster].append(diff)
        for level, by in sorted(by_level.items()):
            diffs = [x for v in by.values() for x in v]
            comparisons.append({'workload': name, 'unit': label, 'kind': kind, 'concurrency_level': level, 'matched_pairs': len(diffs), 'clusters': len(by),
                                'elapsed_difference_mean_ms': round(float(np.mean(diffs)), 1), 'elapsed_difference_median_ms': round(float(np.median(diffs)), 1),
                                'elapsed_difference_mean_cluster_bootstrap95': UN.cluster_bootstrap(by)})
        if d['unmatched']:
            comparisons.append({'workload': name, 'unit': label, 'kind': kind, 'concurrency_level': 'arms differ', 'matched_pairs': 0, 'excluded_pairs': len(d['unmatched']),
                                'note': 'Arms ran at different concurrency; excluded from latency comparison (TB-035 risk).'})
    return rows, comparisons


def main():
    rows, comps, ledger, records = [], [], [], {}
    for name, path in CFG['workloads'].items():
        rec, runs, calls, pairs = load_workload(name, path)
        r, c = summarise(name, runs, calls, pairs)
        rows += r; comps += c; ledger += calls
        levels = sorted({x['concurrency_level'] for x in runs.values()})
        records[name] = {'record': path, 'runs': len(runs), 'model_call_attempts': len(calls), 'concurrency_levels_observed': levels,
                         'max_concurrent_runs': max(levels) + 1, 'pairs': len(pairs)}
    out = CFG['outputs']
    pd.DataFrame(rows).to_csv(ROOT / out['csv'], index=False)
    pd.DataFrame(ledger).to_csv(ROOT / out['ledger'], index=False)
    retry = {**RECOVERY['retry'], **OVERRIDE.get('retry', {})}
    settings = {'concurrency': CFG['concurrency'] | {'observed': records},
                'provider_price': {k: PRICE[k] for k in ('provider', 'service_tier', 'pricing_model_id', 'input_usd_per_million_tokens', 'output_usd_per_million_tokens', 'verified_at', 'source_url')},
                'retry': {'max_attempts_per_call': retry['max_attempts_per_call'], 'attempt_timeout_ms': retry['attempt_timeout_ms'], 'backoff': retry['backoff'],
                          'transient_http_status': retry['transient_http_status'], 'model_retry_provider_codes': RECOVERY['model']['retry_provider_codes'],
                          'budget_max_retries': BUDGET['limits']['max_retries'], 'source': f"{HC['runtime_settings']['configs/recovery.yaml']} + {HC['reliability']['override_file']}"},
                'rate_and_limits': {'min_interval_ms': PACE['min_interval_ms'], 'temperature': PACE['temperature'], 'run_timeout_ms': LIVE['timeout_ms'], 'budget_limits': BUDGET['limits']},
                'model': HC['model'], 'system': HC['defended_system']['system']}
    meta = {'task_id': 'TB-035', 'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'settings': settings, 'latency_comparisons': comps,
            'outputs': out, 'note': 'Latency is end-to-end per run (queueing and retries included). Costs come from the ledger of every model-call attempt; the free tier bills zero, so tokens are the operating-cost measure.'}
    (ROOT / out['json']).write_text(json.dumps(meta, indent=1) + '\n')
    write_doc(meta, rows)
    print(json.dumps({'rows': len(rows), 'ledger_rows': len(ledger), 'comparisons': len(comps), 'concurrency': {k: v['concurrency_levels_observed'] for k, v in records.items()}}))


def write_doc(meta, rows):
    s = meta['settings']
    L = ['# Latency and operating cost (TB-035)', '',
         f"Generated by `scripts/measure-cost-latency.py` from the TB-027 spans of the confirmatory workloads. Model `{s['model']}`, system `{s['system']}`.", '',
         '## Settings the comparison depends on', '',
         f"- Concurrency: {s['concurrency']['definition']}. Observed levels: " + '; '.join(f"{k}: {v['concurrency_levels_observed']} (at most {v['max_concurrent_runs']} runs at once)" for k, v in s['concurrency']['observed'].items()) + '.',
         f"- Provider price: {s['provider_price']['input_usd_per_million_tokens']} USD per million input and {s['provider_price']['output_usd_per_million_tokens']} per million output tokens "
         f"({s['provider_price']['service_tier']} tier, {s['provider_price']['provider']}), verified {s['provider_price']['verified_at'][:10]} at {s['provider_price']['source_url']}.",
         f"- Retries: at most {s['retry']['max_attempts_per_call']} attempts per call, attempt timeout {s['retry']['attempt_timeout_ms']} ms, backoff {json.dumps(s['retry']['backoff'])}, "
         f"retried provider codes {', '.join(s['retry']['model_retry_provider_codes'])}, budget max retries {s['retry']['budget_max_retries']} ({s['retry']['source']}).",
         f"- Pacing and limits: at least {s['rate_and_limits']['min_interval_ms']} ms between model requests per lane, run timeout {s['rate_and_limits']['run_timeout_ms']} ms, budget limits {json.dumps(s['rate_and_limits']['budget_limits'])}.", '',
         '## Per completed task (all attempts included)', '',
         '| Workload | Run | Kind | Arm | Concurrency | Runs | p50 / p95 time (s) | Tokens agent + defense | Failed call attempts | Billed USD | Successful tasks | Tokens per successful task |',
         '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for r in rows:
        L.append(f"| {r['workload']} | {r['unit']} | {r['kind']} | {r['arm']} | {r['concurrency_level']} | {r['runs']} | {r['elapsed_p50_ms'] / 1000:.1f} / {r['elapsed_p95_ms'] / 1000:.1f} | "
                 f"{r['agent_input_tokens'] + r['agent_output_tokens']:,} + {r['defense_input_tokens'] + r['defense_output_tokens']:,} | {r['failed_model_call_attempts']} | {r['billed_usd']:.2f} | "
                 f"{r['successful_tasks']} | {r['tokens_per_successful_task'] if r['tokens_per_successful_task'] is not None else 'undefined (no success)'} |")
    L += ['', '## Paired latency, defended minus baseline, at matched concurrency only', '',
          '| Workload | Run | Kind | Concurrency | Matched pairs | Clusters | Mean difference (s) | 95% cluster bootstrap (s) | Median difference (s) |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for c in meta['latency_comparisons']:
        if c['matched_pairs'] == 0:
            L.append(f"| {c['workload']} | {c['unit']} | {c['kind']} | arms differ | 0 (excluded {c['excluded_pairs']}) | — | — | — | — |")
            continue
        ci = c['elapsed_difference_mean_cluster_bootstrap95']
        L.append(f"| {c['workload']} | {c['unit']} | {c['kind']} | {c['concurrency_level']} | {c['matched_pairs']} | {c['clusters']} | {c['elapsed_difference_mean_ms'] / 1000:+.1f} | "
                 f"{'—' if not ci else f'[{ci[0] / 1000:+.1f}, {ci[1] / 1000:+.1f}]'} | {c['elapsed_difference_median_ms'] / 1000:+.1f} |")
    L += ['', 'Rows at different concurrency levels are not compared with each other. Latency includes queueing for pacing, retries and backoff; a run that hit the '
          f"{s['rate_and_limits']['run_timeout_ms'] // 1000} s timeout counts at its full time. Billed cost is zero on the free tier, so tokens per successful task is the operating-cost measure; "
          'a group with no successful task reports it as undefined, not zero. The ledger (`' + meta['outputs']['ledger'] + '`) lists every model-call attempt, failed ones included.', '']
    (ROOT / meta['outputs']['doc']).write_text('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
