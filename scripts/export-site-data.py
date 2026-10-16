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
(out / 'runs.json').write_text(json.dumps({'fields': FIELDS, 'rows': rows}, separators=(',', ':'), ensure_ascii=False))
leaks = [p.name for p in out.rglob('*.json') if red.find(p.read_text())]
digest = hashlib.sha256(b''.join((out / p).read_bytes() for p in sorted(str(x.relative_to(out)) for x in out.rglob('*.json')))).hexdigest()
print(json.dumps({'runs': len(rows), 'record_files': len(records), 'span_files': len(spans), 'hero_run': store['hero_run'], 'leaks': leaks, 'export_sha256': digest}))
sys.exit(1 if leaks else 0)
