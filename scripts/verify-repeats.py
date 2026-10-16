#!/usr/bin/env python3
"""TB-028 end-to-end acceptance: execute the same fixed task-seed units in two different orders through the real harness
(scripted model, deterministic) and check that pairing, denominators and every result are identical."""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.evaluation.repeats import build_schedule, evaluate, load_runs, registry  # noqa: E402
from src.splits import sealed_fixture_ids  # noqa: E402

suite = 'tests/arms/smoke-cases.json'
holdout = sealed_fixture_ids()
# Scripted-only cases are harness tests (another trajectory on an existing unit), not experimental units.
cases = [c for c in json.loads((ROOT / suite).read_text())['cases'] if not c.get('scripted_only') and c['fixture_id'].split('--')[0] not in holdout and c.get('attack_id') not in holdout]
base = registry()['pair_order_seed']
results = {}
for label, order_seed in (('order_a', base + 1), ('order_b', base + 2)):
    sched = build_schedule(cases, repetitions=2, order_seed=order_seed)
    path = ROOT / f'reports/tests/tb028-schedule-{label}.json'
    path.write_text(json.dumps(sched, indent=1) + '\n')
    subprocess.run(['node', 'scripts/run-arm-smoke.mjs', '--schedule', str(path.relative_to(ROOT)), '--work-dir', f'.tool-state/arms-tb028-{label}'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    found = sorted((ROOT / 'reports/tests').glob(f"tb024-scripted-*-sched-{sched['order_sha256'][:8]}-report.json"))
    if len(found) != 1: sys.exit(f'expected one report for schedule {label}, found {len(found)}')
    report_path = found[0]
    rep = json.loads(report_path.read_text())
    results[label] = {'schedule': sched, 'report': rep, 'evaluation': evaluate(load_runs([rep]), sched)}

a, b = results['order_a'], results['order_b']
executed = lambda r: [(c['unit_id']) for c in r['report']['cases']]
pairing = lambda r: sorted((c['unit_id'], c['repetition'], c['case_id'], c['fixture_id']) for c in r['report']['cases'])
checks = {
    'same_units_and_seeds': a['schedule']['content_sha256'] == b['schedule']['content_sha256'],
    'execution_order_differs': executed(a) != executed(b),
    'executed_in_schedule_order': all(executed(r) == [e['unit_id'] for e in sorted(r['schedule']['entries'], key=lambda e: e['position'])] for r in (a, b)),
    'same_pairing': pairing(a) == pairing(b),
    'no_missing_or_unscheduled_units': all(not v['integrity']['missing_units'] and not v['integrity']['unscheduled_units'] for r in (a, b) for v in r['evaluation']['systems'].values()),
    'identical_denominators_and_results': json.dumps(a['evaluation']['systems'], sort_keys=True) == json.dumps(b['evaluation']['systems'], sort_keys=True),
}
out = {'task_id': 'TB-028', 'suite': suite, 'units': len(a['schedule']['entries']), 'repetitions': 2,
       'order_sha256': {k: v['schedule']['order_sha256'] for k, v in results.items()}, 'checks': checks, 'ok': all(checks.values())}
(ROOT / 'evidence/tb028-order-invariance-report.json').write_text(json.dumps(out, indent=1) + '\n')
print(json.dumps(out, indent=1))
sys.exit(0 if out['ok'] else 1)
