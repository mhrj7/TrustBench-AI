#!/usr/bin/env python3
"""TB-030 acceptance: a reviewer can open the raw evidence behind any displayed aggregate.

For every grouping the dashboard offers (the default and each single dimension, unfiltered and per model), every
aggregate cell is recomputed from the raw records of exactly the run IDs it lists (each opened through its report path,
SHA-256 and JSON pointer), and must match what the dashboard shows. Policy and outcome counts are checked the same way, in
both directions (no run outside the listed IDs contributes). Shared-demo redaction must leave no sensitive value in any
record. Writes evidence/tb030-dashboard-report.json. No number is typed by hand."""
import json, sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import views  # noqa: E402
from app.redact import Redactor  # noqa: E402
from app.store import load_config, load_runs, raw_record, run_id, verify_index  # noqa: E402
from src.analysis.localize import Contracts  # noqa: E402

cfg = load_config()
index = json.loads((ROOT / cfg['index_file']).read_text())
problems = verify_index(index, cfg)
runs = load_runs(index, cfg)
by_id = {r['run_id']: r for r in runs}
metrics = {k: v for k, v in cfg['metrics'].items() if isinstance(v, dict)}
is_denial = Contracts().is_defense_denial
failures: list[str] = []

# 1. Every run opens to its raw record, and the record reproduces the fields the dashboard shows for it.
raw = {}
for r in runs:
    rec = raw_record(r)  # raises if the report no longer has its indexed hash
    side, case = rec['run'], rec['case']
    raw[r['run_id']] = side
    if run_id(r['report'], case, r['pointer'].rsplit('/', 1)[1]) != r['run_id']:
        failures.append(f"{r['run_id']}: pointer resolves to another run")
    ev = side['evaluation']
    for field, value in (('utility_pass', ev['utility_pass']), ('security_pass', ev['security_pass']), ('attacker_goal', ev['attacker_goal_achieved']),
                         ('invalid', side['invalid']), ('outcome', side['outcome'])):
        if r[field] != value:
            failures.append(f"{r['run_id']}: {field} shown {r[field]!r}, raw {value!r}")


def check_aggregates(subset, dims, label):
    cells = 0
    for g in views.aggregate(subset, dims, metrics, cfg['wilson_z']):
        members = set(g['run_ids'])
        expect = {r['run_id'] for r in subset if tuple(r[d] for d in dims) == tuple(g['key'][d] for d in dims)}
        if members != expect:
            failures.append(f'{label} {g["key"]}: listed runs differ from the runs in the group')
        for m, spec in metrics.items():
            x = g['metrics'][m]
            counted = [i for i in g['run_ids'] if not raw[i]['invalid'] and (spec['kinds'] is None or by_id[i]['kind'] in spec['kinds'])]
            field = {'utility_pass': 'utility_pass', 'security_pass': 'security_pass', 'attacker_goal': 'attacker_goal_achieved'}[spec['field']]
            k = sum(bool(raw[i]['evaluation'][field]) for i in counted)
            if (x['k'], x['n']) != (k, len(counted)) or set(x['hit_ids']) | set(x['miss_ids']) != set(counted) or set(x['hit_ids']) & set(x['miss_ids']):
                failures.append(f'{label} {g["key"]} {m}: shown {x["k"]}/{x["n"]}, raw {k}/{len(counted)}')
            cells += 1
    return cells


groupings = [cfg['default_group']] + [[d] for d in cfg['group_dimensions']]
valid = views.apply_filters(runs, {}, include_invalid=False)
everything = views.apply_filters(runs, {}, include_invalid=True)
metric_cells = 0
for dims in groupings:
    metric_cells += check_aggregates(valid, dims, f'all valid / {dims}')
    metric_cells += check_aggregates(everything, dims, f'with invalid / {dims}')
for model in sorted({r['model'] for r in runs}):
    metric_cells += check_aggregates(views.apply_filters(runs, {'model': [model]}), cfg['default_group'], f'model={model}')

# 2. Policy and outcome counts, recomputed from raw records in both directions.
policy_rows = 0
for source in ('gateway', 'agent'):
    for dims in groupings:
        rows = views.policy_reasons(valid, dims, source, is_denial)
        for row in rows:
            key = tuple(row['key'][d] for d in dims)
            def items(i):
                side = raw[i]
                if source == 'gateway':
                    return [(d['decision'], d.get('reason') or '') for d in side.get('policy_decisions') or []]
                return [('denied', t['error']) for t in side['tool_trace'] if t.get('error') and is_denial(t['error'])]
            want = (row['key']['decision'], row['key']['reason'])
            contributing = {r['run_id'] for r in valid if tuple(r[d] for d in dims) == key and want in items(r['run_id'])}
            count = sum(items(r['run_id']).count(want) for r in valid if tuple(r[d] for d in dims) == key)
            if set(row['run_ids']) != contributing or row['count'] != count:
                failures.append(f'policy {source} {row["key"]}: shown {row["count"]} in {len(row["run_ids"])} runs, raw {count} in {len(contributing)}')
            policy_rows += 1
outcome_rows = 0
for dims in groupings:
    for row in views.outcome_counts(valid, dims):
        key = tuple(row['key'][d] for d in dims)
        want = {r['run_id'] for r in valid if tuple(r[d] for d in dims) == key and raw[r['run_id']]['outcome'] == row['key']['outcome']}
        if set(row['run_ids']) != want or row['runs'] != len(want):
            failures.append(f'outcomes {row["key"]}: listed runs differ from raw')
        outcome_rows += 1

# 3. Shared-demo redaction: no sensitive value survives in any record the dashboard can open.
red = Redactor.for_dashboard(cfg)
leaks, redacted_records = [], 0
for r in runs:
    before = red.replaced
    text = json.dumps(red.value(raw_record(r)), ensure_ascii=False)
    redacted_records += red.replaced > before
    leaks += [f"{r['run_id']}: {s[:12]}…" for s in red.find(text)]  # any spelling variant counts as a leak

ok = not problems and not failures and not leaks
report = {'task_id': 'TB-030', 'ok': ok, 'store_version': index['store_version'], 'index_problems': problems,
          'runs': len(runs), 'runs_opened_to_raw_record': len(raw), 'groupings': [list(g) for g in groupings],
          'aggregate_metric_cells_checked': metric_cells, 'policy_rows_checked': policy_rows, 'outcome_rows_checked': outcome_rows,
          'redaction': {'sensitive_values': len(red.secrets), 'records_with_replacements': redacted_records, 'leaks': leaks[:20], 'leak_count': len(leaks)},
          'failures': failures[:50], 'failure_count': len(failures),
          'invalid_runs': sum(r['invalid'] for r in runs), 'outcomes': dict(Counter(r['outcome'] for r in runs))}
(ROOT / 'evidence/tb030-dashboard-report.json').write_text(json.dumps(report, indent=1) + '\n')
print(json.dumps({k: report[k] for k in ('ok', 'runs', 'aggregate_metric_cells_checked', 'policy_rows_checked', 'outcome_rows_checked', 'failure_count')} | {'leaks': len(leaks), 'redacted_records': redacted_records}))
sys.exit(0 if ok else 1)
