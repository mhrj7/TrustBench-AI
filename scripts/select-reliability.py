#!/usr/bin/env python3
"""TB-031: apply the A-024 decision rule to the reliability-sweep reports (evidence/tb031-*-report.json).

For each configuration in configs/reliability-sweep.yaml: defended-arm runtime-limit termination rate, unsafe
committed-effect rate (attack cases), benign utility (benign cases), mean elapsed time, invalid runs, with Wilson and
cluster-bootstrap intervals. Writes configs/frozen/reliability.json and docs/reliability-sweep.md. Exit 0 when every
configuration has a report; the chosen settings are in the JSON (the registered values unless the rule changes one)."""
import glob, json, sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.views import wilson  # noqa: E402
from src.evaluation.reliability import decide  # noqa: E402

sweep = json.loads((ROOT / 'configs/reliability-sweep.yaml').read_text())
reg = json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())
sel = json.loads((ROOT / 'configs/frozen/selection.json').read_text())
holdout = set(json.loads((ROOT / reg['holdout']['split_manifest']).read_text())['holdout_manifest']['fixture_ids'])
term_codes = set(sweep['termination_codes'])
dec = {k: v / 100 for k, v in sweep['decision'].items()}
B, SEED = reg['uncertainty']['bootstrap_resamples'], reg['pair_order_seed'] + 24
z = 1.959963984540054

reports = {}
for p in glob.glob(str(ROOT / f"evidence/{sweep['report_prefix']}-*-report.json")):
    r = json.loads(Path(p).read_text())
    if (r.get('reliability') or {}).get('name'):
        reports[r['reliability']['name']] = (p, r)
missing = [c['name'] for c in sweep['configurations'] if c['name'] not in reports]
if missing:
    sys.exit(f'no sweep report yet for: {", ".join(missing)}')


def boot(values_by_cluster):
    per = np.array([np.mean(v) for v in values_by_cluster.values() if v])
    if len(per) < 2:
        return None
    rng = np.random.default_rng(SEED)
    m = per[rng.integers(0, len(per), size=(B, len(per)))].mean(axis=1)
    return [round(float(np.percentile(m, 2.5)), 4), round(float(np.percentile(m, 97.5)), 4)]


def measure(r):
    rows = {'attack': [], 'benign': []}
    invalid = 0
    for case in r['cases']:
        if case['fixture_id'].split('--')[0] in holdout or (case.get('attack_id') or '') in holdout:
            sys.exit('a sweep report contains a holdout fixture (A-024)')
        d = case['defended']
        if d['invalid']:
            invalid += 1
            continue
        rows[case['kind']].append({'cluster': (case['fixture_id'].split('--')[0], case.get('attack_id') or 'none'), 'term': bool(term_codes & set(d['failures'])),
                                   'unsafe': not d['evaluation']['security_pass'], 'util': bool(d['evaluation']['utility_pass']), 'elapsed': d.get('elapsed_ms') or 0})
    every = rows['attack'] + rows['benign']
    def stat(rs, key):
        k = sum(x[key] for x in rs)
        by = defaultdict(list)
        for x in rs: by[x['cluster']].append(x[key])
        return {'k': k, 'n': len(rs), 'rate': k / len(rs) if rs else None, 'wilson95': wilson(k, len(rs), z), 'bootstrap95': boot(by)}
    return {'termination': stat(every, 'term'), 'unsafe': stat(rows['attack'], 'unsafe'), 'utility': stat(rows['benign'], 'util'),
            'mean_elapsed_ms': round(float(np.mean([x['elapsed'] for x in every])), 1) if every else None, 'invalid_defended_runs': invalid,
            'pairs': len(r['cases'])}


m = {name: measure(r) for name, (_, r) in reports.items()}
reg_m = m['registered']
verdicts = []
for c in sweep['configurations']:
    if c['name'] == 'registered':
        continue
    a = m[c['name']]
    dT, dS, dU, rule_a, rule_b = decide(reg_m, a, bool(c.get('cheaper')), dec)
    verdicts.append({'name': c['name'], 'factor': c['factor'], 'delta_termination_pp': round(dT * 100, 2), 'delta_unsafe_pp': round(dS * 100, 2),
                     'delta_utility_pp': round(dU * 100, 2), 'delta_elapsed_ms': round(a['mean_elapsed_ms'] - reg_m['mean_elapsed_ms'], 1),
                     'qualifies': rule_a or rule_b, 'by_rule': 'a' if rule_a else 'b' if rule_b else None})

chosen = {}
for factor in sorted({v['factor'] for v in verdicts}):
    q = [v for v in verdicts if v['factor'] == factor and v['qualifies']]
    if q:
        chosen[factor] = sorted(q, key=lambda v: (v['delta_termination_pp'], v['delta_elapsed_ms']))[0]['name']
needs_confirmation = len(chosen) > 1
record = {'task_id': 'TB-031', 'rule': 'protocol/amendments.md A-024', 'analysed_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
          'condition': {'system': sel['selected']['system'], 'model': sel['selected']['model'], 'prompt_profile': sel['selected']['prompt_profile'],
                        'attack_rendering': sel['data']['selection_condition']['attack_rendering'], 'repetitions': sweep['repetitions']},
          'reports': {k: str(Path(p).relative_to(ROOT)) for k, (p, _) in reports.items()}, 'measures': m, 'verdicts': verdicts,
          'chosen_changes': {f: next(c for c in sweep['configurations'] if c['name'] == n) for f, n in chosen.items()},
          'combined_confirmation_required': needs_confirmation,
          'result': 'registered values kept' if not chosen else ('changes adopted' if not needs_confirmation else 'combined setting must be confirmed (A-024)'),
          'caveat': 'About 27 attack and 21 benign runs per arm and configuration; only large effects can be detected. A kept setting is not shown to be optimal.'}
(ROOT / 'configs/frozen/reliability.json').write_text(json.dumps(record, indent=1) + '\n')

pc = lambda s: '—' if s['rate'] is None else f"{s['rate'] * 100:.1f}% ({s['k']}/{s['n']})"
lines = ['# Reliability sweep (TB-031)', '', f"Generated by `scripts/select-reliability.py` under rule A-024. Condition: `{record['condition']['system']}` on `{record['condition']['model']}`, "
         f"`{record['condition']['prompt_profile']}`, `{record['condition']['attack_rendering']}`, {sweep['repetitions']} repetitions of every tuning case, both arms with identical settings.", '',
         '| Configuration | Runtime-limit terminations (defended) | Unsafe committed effect | Benign utility | Mean elapsed | Invalid |', '| --- | --- | --- | --- | --- | --- |']
for c in sweep['configurations']:
    x = m[c['name']]
    lines.append(f"| {c['name']} | {pc(x['termination'])} | {pc(x['unsafe'])} | {pc(x['utility'])} | {x['mean_elapsed_ms'] / 1000:.1f} s | {x['invalid_defended_runs']} |")
lines += ['', '| Alternative | Δ terminations | Δ unsafe | Δ utility | Δ elapsed | Qualifies |', '| --- | --- | --- | --- | --- | --- |']
for v in verdicts:
    lines.append(f"| {v['name']} | {v['delta_termination_pp']:+.1f} pp | {v['delta_unsafe_pp']:+.1f} pp | {v['delta_utility_pp']:+.1f} pp | {v['delta_elapsed_ms'] / 1000:+.1f} s | {'yes (rule ' + v['by_rule'] + ')' if v['qualifies'] else 'no'} |")
lines += ['', f"**Result:** {record['result']}" + (f" ({', '.join(f'{f}: {n}' for f, n in chosen.items())})." if chosen else '.'), '', f"Caveat: {record['caveat']}", '']
(ROOT / 'docs/reliability-sweep.md').write_text('\n'.join(lines) + '\n')
print(json.dumps({'result': record['result'], 'chosen': chosen, 'verdicts': [(v['name'], v['delta_termination_pp'], v['delta_unsafe_pp'], v['delta_utility_pp'], v['qualifies']) for v in verdicts]}))

# --- apply to the frozen holdout configuration ---------------------------------------------------------------------------------
# Adopted changes go into an explicit override file passed to the holdout runner (--reliability), so the registered
# defaults used by other tasks stay untouched; the manifest is recomputed over every frozen file.
import hashlib
frozen_dir = ROOT / 'configs/frozen'
hc_path = frozen_dir / 'holdout-config.json'
hc = json.loads(hc_path.read_text())
override = {'name': 'frozen-holdout'}
for change in record['chosen_changes'].values():
    override.update({k: v for k, v in change.items() if k not in ('name', 'factor', 'cheaper')})
if needs_confirmation:
    hc['reliability'] = {'status': 'pending combined confirmation (A-024)'}
elif len(override) > 1:
    (frozen_dir / 'reliability-override.json').write_text(json.dumps(override, indent=2) + '\n')
    hc['reliability'] = {'decided_by': 'configs/frozen/reliability.json (A-024)', 'override_file': 'configs/frozen/reliability-override.json',
                         'runner_flag': '--reliability configs/frozen/reliability-override.json', 'changes': override}
else:
    (frozen_dir / 'reliability-override.json').unlink(missing_ok=True)
    hc['reliability'] = {'decided_by': 'configs/frozen/reliability.json (A-024)', 'changes': None, 'note': 'registered values kept'}
hc_path.write_text(json.dumps(hc, indent=1) + '\n')
lines = [f"{hashlib.sha256(x.read_bytes()).hexdigest()}  {x.relative_to(ROOT)}" for x in sorted(frozen_dir.rglob('*')) if x.is_file() and x.name != 'MANIFEST.sha256']
(frozen_dir / 'MANIFEST.sha256').write_text('\n'.join(lines) + '\n')

