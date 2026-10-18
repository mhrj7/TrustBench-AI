#!/usr/bin/env python3
"""TB-030: export the versioned run store for the review website (web/), redacted.

Writes web/public/data/: store.json (store version, index entries, dimensions, metric specs, attribution accuracy, hero
run), runs.json (one compact row per run, enough to filter, aggregate and attribute), records/<n>.json (each report's
redacted raw records, keyed by JSON pointer, opened on demand) and spans/<n>.json (TB-027 spans per run, where recorded).
A static site cannot hide data, so everything exported is redacted with the dashboard set (app/redact.py); there is no
unredacted export. Run IDs, report paths, SHA-256 and pointers are kept, so every number still opens to its record."""
import hashlib, json, shutil, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.redact import Redactor  # noqa: E402
from app.store import load_config, load_runs, raw_record, run_spans, verify_index  # noqa: E402
from src.analysis.localize import Contracts  # noqa: E402

cfg = load_config()
index = json.loads((ROOT / cfg['index_file']).read_text())
problems = verify_index(index, cfg)
if problems:
    sys.exit('run-store index is stale; run npm run dashboard:index first:\n' + '\n'.join(problems))
runs = load_runs(index, cfg)
red = Redactor.for_dashboard(cfg)
out = ROOT / cfg['site']['data_dir']
if out.exists():
    shutil.rmtree(out)
(out / 'records').mkdir(parents=True)
(out / 'spans').mkdir()

reports = [e for e in index['entries'] if e['kind'] == 'report']
report_no = {e['path']: i for i, e in enumerate(reports)}
FIELDS = ['run_id', 'report', 'pointer', 'model', 'system', 'rendering', 'profile', 'kind', 'case_id', 'repetition', 'arm', 'outcome',
          'invalid', 'utility_pass', 'security_pass', 'attacker_goal', 'steps', 'elapsed_ms', 'tokens_in', 'tokens_out', 'timed',
          'utility_rule', 'utility_step', 'security_rule', 'security_step', 'first_rule', 'first_step', 'policy', 'trace_errors', 'reason_codes']
rows = []
for r in runs:
    row = dict(r, report=report_no[r['report']], timed=bool(r['spans_file']))
    rows.append([red.value(row[f]) if f in ('policy', 'trace_errors') else row[f] for f in FIELDS])

records: dict[int, dict] = {}
spans: dict[int, dict] = {}
for r in runs:
    n = report_no[r['report']]
    rec = red.value(raw_record(r))
    records.setdefault(n, {'report': r['report'], 'sha256': r['report_sha256'], 'runs': {}})['runs'][r['pointer']] = {'case': rec['case'], 'run': rec['run']}
    if r['spans_file']:
        s = run_spans(r)
        if s:
            spans.setdefault(n, {})[r['pointer']] = [red.value({k: x[k] for k in ('name', 'start_ms', 'end_ms', 'duration_ms', 'status', 'attributes')}) for x in s]
for n, body in records.items():
    (out / 'records' / f'{n}.json').write_text(json.dumps(body, separators=(',', ':'), ensure_ascii=False))
for n, body in spans.items():
    (out / 'spans' / f'{n}.json').write_text(json.dumps(body, separators=(',', ':'), ensure_ascii=False))

valid = [r for r in runs if not r['invalid']]
hero = next((r for r in sorted(valid, key=lambda r: r['run_id']) if r['spans_file'] and not (r['utility_pass'] and r['security_pass'])
             and any(d == 'deny' for _, d, _ in r['policy']) and run_spans(r)), None)
accuracy = json.loads((ROOT / 'evidence/tb029-attribution-accuracy.json').read_text())
store = {
    'task_id': 'TB-030', 'exported_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'store_version': index['store_version'],
    'git_commit': index.get('git_commit'), 'redaction': {'sensitive_values': len(red.secrets), 'mode': 'redacted (static export; no unredacted variant exists)'},
    'reports': [{'n': i, 'path': e['path'], 'sha256': e['sha256'], 'runs': e['runs']} for i, e in enumerate(reports)],
    'span_reports': sorted(spans), 'attribution_file': next((e for e in index['entries'] if e['kind'] == 'attribution'), None),
    'fields': FIELDS, 'filters': cfg['filters'], 'group_dimensions': cfg['group_dimensions'], 'default_group': cfg['default_group'],
    'metrics': {k: v for k, v in cfg['metrics'].items() if isinstance(v, dict)}, 'wilson_z': cfg['wilson_z'],
    'hero_run': hero['run_id'] if hero else None,
    'denial': {'codes': sorted(Contracts().denial_codes), 'prefixes': list(Contracts().denial_prefixes)},
    'attribution': {'notes': json.loads((ROOT / 'data/reviews/attribution-audit-defects.json').read_text())['rounds'][str(accuracy['measured_accuracy']['round'])].get('notes', []),
                    'measured': accuracy['measured_accuracy'], 'rounds': {k: {kk: v[kk] for kk in ('localizer_version', 'cases', 'note', 'summary', 'corrections')}
                                                                           for k, v in accuracy['ai_audit']['rounds'].items()},
                    'constructed': {k: accuracy['constructed_ground_truth'][k] for k in ('cases', 'correct')}, 'reviewer': accuracy['ai_audit']['reviewer']},
}
(out / 'store.json').write_text(json.dumps(store, indent=1, ensure_ascii=False))


def headline() -> dict:
    """The story page's numbers and its real example (configs/site-headline.json): read from evidence, never typed in."""
    hc = json.loads((ROOT / 'configs/site-headline.json').read_text())
    h = json.loads((ROOT / hc['hypothesis']).read_text())
    la = json.loads((ROOT / hc['label_audit']).read_text())
    rp = json.loads((ROOT / hc['reproduction']).read_text())
    wt = json.loads((ROOT / hc['walkthrough']).read_text())
    ep = lambda e: {k: e[k] for k in ('baseline', 'defended', 'baseline_rate', 'defended_rate', 'difference_pp', 'ci95_pp', 'clusters')}
    attack_id = wt['blocked_attack']['defended']['fixture_id'].split('--')[1]
    attack = next(a for a in map(json.loads, filter(str.strip, (ROOT / hc['attacks']).read_text().splitlines())) if a['attack_id'] == attack_id)
    side = lambda x: {'run_id': x['run_id'], 'outcome': x['outcome'], 'security_pass': x['security_pass'], 'utility_pass': x['utility_pass'],
                      'attacker_goal_achieved': x['attacker_goal_achieved'], 'tools': x['tool_calls'], 'decisions': x['policy_decisions'], 'reason_codes': x['reason_codes']}
    comparison = []
    for sysd in hc['comparison']['systems']:
        rep = json.loads((ROOT / sysd['report']).read_text())['summary']['unsafe_committed_effect']
        comparison.append({'id': sysd['id'], 'label': sysd['label'], 'defended': rep['defended'], 'baseline': rep['baseline']})
    return {'source': 'configs/site-headline.json', 'primary': {'analysis': h['primary']['analysis'], 'pairs': h['primary']['pairs'], 'verdict': h['primary']['verdict'],
                                                              'unsafe': ep(h['primary']['unsafe_committed_effect']), 'utility': ep(h['primary']['benign_utility_pass'])},
            'confidence': h['bootstrap']['level'], 'holdout1_verdict': next(x['verdict'] for x in h['per_holdout'] if x['analysis'].startswith('holdout1/')),
            'extra_seconds': round(h['cost']['paired_descriptive_primary_pool']['elapsed_ms']['paired_difference_mean'] / 1000, 1),
            'confirmatory_runs': la['method']['population_runs'], 'audit': {'sampled': la['evaluator_error']['security_pass']['n'],
                                                                          'security_errors': la['evaluator_error']['security_pass']['errors'],
                                                                          'oracle_defects': la['evaluator_error']['attacker_goal_achieved']['errors']},
            'reproduction': {'steps': len(rp['steps']), 'outcome': rp['outcome']},
            'example': {'case_id': wt['blocked_attack']['defended']['case_id'], 'repetition': wt['blocked_attack']['defended']['repetition'],
                        'task': red.scrub(next(f for f in map(json.loads, filter(str.strip, (ROOT / 'data/benign.jsonl').read_text().splitlines())) if f['fixture_id'] == attack['base_fixture_id'])['task_contract']['request']),
                        'hidden_text': red.scrub(attack['untrusted_text']), 'attacker_goal': red.scrub(attack['attacker_goal']),
                        'without_guard': side(wt['blocked_attack']['paired_undefended']), 'with_guard': side(wt['blocked_attack']['defended'])},
            'comparison': {'note': hc['comparison']['note'], 'systems': comparison}}


def pipeline() -> dict:
    """The How it works page's numbers (configs/site-pipeline.json): counted from the data, configs and run store."""
    pc = json.loads((ROOT / 'configs/site-pipeline.json').read_text())
    lines = lambda f: [json.loads(x) for x in (ROOT / f).read_text().splitlines() if x.strip()]
    load = lambda f: json.loads((ROOT / f).read_text())
    gateway = (ROOT / pc['gateway_source']).read_text()
    missing = [l['id'] for l in pc['guard_layers'] if f"'{l['id']}'" not in gateway or f"'{l['denies_with']}'" not in (ROOT / l['source']).read_text()]
    if missing:
        raise SystemExit(f'site-pipeline: guard layers not found in {pc["gateway_source"]}: {missing}')
    col = {f: i for i, f in enumerate(FIELDS)}
    valid = [r for r in rows if not r[col['invalid']]]
    holdouts = {Path(f).stem: len(load(f)['cases']) for f in pc['holdouts']}
    return {'source': 'configs/site-pipeline.json',
            'tasks': len(lines(pc['tasks'])), 'attacks': len(lines(pc['attacks'])), 'oracles': len(load(pc['oracles'])['attacks']),
            'renderings': sorted(load(pc['renderings'])['renderings']), 'tools': sorted(load(pc['tools'])['descriptions']),
            'providers': sorted(load(pc['providers'])['providers']), 'models': sorted({r[col['model']] for r in rows}),
            'systems': sorted({r[col['system']] for r in rows}), 'case_groups': len(load(pc['splits'])['groups']), 'holdouts': holdouts,
            'reports': len(store['reports']), 'runs': len(rows), 'valid_runs': len(valid),
            'outcomes': {o: sum(1 for r in rows if r[col['outcome']] == o) for o in sorted({r[col['outcome']] for r in rows})},
            'denial_codes': store['denial']['codes'], 'guard_layers': pc['guard_layers'], 'stages': pc['stages']}


(out / 'pipeline.json').write_text(json.dumps(pipeline(), indent=1, ensure_ascii=False))
(out / 'headline.json').write_text(json.dumps(headline(), indent=1, ensure_ascii=False))
(out / 'runs.json').write_text(json.dumps({'fields': FIELDS, 'rows': rows}, separators=(',', ':'), ensure_ascii=False))
leaks = [p.name for p in out.rglob('*.json') if red.find(p.read_text())]
digest = hashlib.sha256(b''.join((out / p).read_bytes() for p in sorted(str(x.relative_to(out)) for x in out.rglob('*.json')))).hexdigest()
print(json.dumps({'runs': len(rows), 'record_files': len(records), 'span_files': len(spans), 'hero_run': store['hero_run'], 'leaks': leaks, 'export_sha256': digest}))
sys.exit(1 if leaks else 0)
