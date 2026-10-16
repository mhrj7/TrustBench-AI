#!/usr/bin/env python3
"""TB-029: localize every valid failed run in the live evidence and write reports/attribution.csv, plus a stratified sample
for human review. Reviewed labels (data/reviews/attribution-reviews.jsonl) are joined in when present."""
import csv, hashlib, json, sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.analysis.localize import Contracts, localize  # noqa: E402

C = Contracts()
cfg = C.cfg
reg = json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())
rows, details = [], {}
for path in sorted((ROOT / 'evidence').glob('tb024-*-report.json')):
    rep = json.loads(path.read_text())
    if rep.get('mode') != 'live_model':
        continue
    system = rep.get('defended_system') or rep.get('defended_variant') or 'capability_only'
    for case in rep['cases']:
        for arm in ('baseline', 'defended'):
            side = case[arm]; ev = side['evaluation']
            if side['invalid'] or (ev['utility_pass'] and ev['security_pass']):
                continue
            failed = {'utility': not ev['utility_pass'], 'security': not ev['security_pass']}
            out = localize(side['tool_trace'], C.for_case(case['fixture_id'], case.get('attack_id')), C, failed=failed, failures=side['failures'])
            run_id = f"{path.name.removesuffix('-report.json')}|{case['case_id']}|r{case['repetition']}|{arm}"
            f, fx = out['first_violation'], out['first_executed_violation']
            eu, es = out['explaining'].get('utility'), out['explaining'].get('security')
            pick = lambda v, k: '' if v is None else v[k]
            prediction = {'first': f and [f['rule'], f['step']], 'utility': eu and [eu['rule'], eu['step']], 'security': es and [es['rule'], es['step']]}
            row = {'run_id': run_id, 'model': rep['model'], 'rendering': rep['attack_rendering'], 'profile': rep['prompt_profile'],
                   'system': system if arm == 'defended' else 'baseline', 'case_id': case['case_id'], 'repetition': case['repetition'], 'arm': arm,
                   'kind': case['kind'], 'utility_pass': ev['utility_pass'], 'security_pass': ev['security_pass'], 'attacker_goal': ev['attacker_goal_achieved'],
                   'steps': len(side['tool_trace']), 'outcome': side['outcome'],
                   'first_rule': pick(f, 'rule'), 'first_step': pick(f, 'step'), 'first_tool': pick(f, 'tool'), 'first_executed': pick(f, 'executed'), 'first_detail': pick(f, 'detail'),
                   'first_executed_rule': pick(fx, 'rule'), 'first_executed_step': pick(fx, 'step'),
                   'utility_rule': pick(eu, 'rule'), 'utility_step': pick(eu, 'step'), 'security_rule': pick(es, 'rule'), 'security_step': pick(es, 'step'),
                   'attributed': out['attributed'], 'prediction_sha256': hashlib.sha256(json.dumps(prediction, sort_keys=True).encode()).hexdigest()[:16]}
            rows.append(row)
            details[run_id] = {'row': row, 'trace': side['tool_trace'], 'failures': side['failures'], 'final_text': side['final_text'], 'violations': out['violations'],
                               'contract': C.for_case(case['fixture_id'], case.get('attack_id'))['contract'], 'evaluation': ev, 'prediction': prediction}

# Stratified, seeded review sample keyed by the failure-explaining rule.
strata: dict[str, list[str]] = {}
for r in rows:
    key = r['utility_rule'] or r['security_rule'] or 'unattributed'
    strata.setdefault(key, []).append(r['run_id'])
rs = cfg['review_sample']
excluded = {c['row']['run_id'] for f in rs['exclude_rounds'] for c in json.loads((ROOT / f).read_text())['cases']}
rng = np.random.default_rng(reg['pair_order_seed'] + rs['seed_offsets'][str(rs['round'])])
sample = []
for key in sorted(strata):
    ids = sorted(i for i in strata[key] if i not in excluded)
    if not ids:
        continue
    take = rng.choice(len(ids), size=min(rs['per_rule'], len(ids)), replace=False)
    sample += [dict(details[ids[i]], stratum=key) for i in sorted(take)]
(ROOT / cfg['sample_file']).write_text(json.dumps({'note': 'TB-029 review sample of localized failures (synthetic fixtures, development split).', 'round': rs['round'], 'localizer_version': cfg['schema_version'], 'cases': sample}, indent=1, default=str) + '\n')

# Join reviewed labels, bound to the exact prediction they reviewed.
reviews = {}
review_path = ROOT / cfg['review_file']
if review_path.exists():
    for line in review_path.read_text().splitlines():
        if line.strip():
            rv = json.loads(line); reviews[(rv['run_id'], rv['prediction_sha256'], rv.get('check', 'utility'))] = rv  # the latest label wins
for r in rows:
    for check in ('utility', 'security'):
        rv = reviews.get((r['run_id'], r['prediction_sha256'], check))
        r[f'human_review_{check}'] = rv['label'] if rv else ''
with open(ROOT / 'reports/attribution.csv', 'w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
counts = {}
for r in rows:
    counts[r['utility_rule'] or r['security_rule'] or 'unattributed'] = counts.get(r['utility_rule'] or r['security_rule'] or 'unattributed', 0) + 1
print(json.dumps({'failed_runs': len(rows), 'unattributed': sum(not r['attributed'] for r in rows), 'review_sample': len(sample), 'human_reviewed_checks': sum(bool(r['human_review_utility']) + bool(r['human_review_security']) for r in rows), 'by_explaining_rule': counts}, indent=1))
