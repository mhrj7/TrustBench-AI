#!/usr/bin/env python3
"""TB-060: conformance and smoke checks for the external agent, end to end.

Each run is a directory holding what scripts/run-arm-smoke.mjs (or the live service) produced for one paired run:
report.json, spans.jsonl and, when available, traces/. For every run it checks:

- the report validates against schemas/arm-report.schema.json and names the pinned external agent;
- validity is honest: invalid pairs carry provider fault codes only and are excluded from every rate;
- every valid run of both arms has the evaluator's verdict and a TB-004 trace that validated;
- the contract checks of scripts/check-external-paired-report.py pass (pinned binary, identical configuration and system
  prompt in both arms, only the contract's tools offered, contract denial codes, no credential in any output file);
- spans: the TB-027 checker passes (every span linked to its run, no seeded sensitive value), every run of both arms has
  spans, model spans are present, and no credential-shaped value or provider key appears;
- optionally (--compare NAME=DIR): the evaluator's verdicts equal the built-in agent's on the same scripted suite.

usage: check-external-smoke.py --run NAME=DIR [--run NAME=DIR ...] [--compare NAME=DIR] [--out evidence/external-smoke-report.json]
"""
import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
ARMS = ('baseline', 'defended')
PROVIDERS = json.loads((ROOT / 'configs/providers.yaml').read_text())['providers']
CREDENTIAL = re.compile(r'Bearer\s+[A-Za-z0-9._-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}')
PROVIDER_FAULTS = {'rate_limit', 'quota_exhausted', 'authentication', 'timeout', 'server', 'network', 'invalid_response', 'invalid_request'}

spec = importlib.util.spec_from_file_location('paired', ROOT / 'scripts/check-external-paired-report.py')
paired = importlib.util.module_from_spec(spec); spec.loader.exec_module(paired)


def schema_errors(report):
    from jsonschema import Draft202012Validator
    v = Draft202012Validator(json.loads((ROOT / 'schemas/arm-report.schema.json').read_text()))
    return [f'{e.json_path}: {e.message[:120]}' for e in v.iter_errors(report)]


def verdict(case, arm):
    a = case[arm]; e = a.get('evaluation') or {}
    return [a['outcome'], e.get('utility_pass'), e.get('security_pass'), e.get('attacker_goal_achieved'), sorted(e.get('reason_codes') or []), a.get('tool_calls')]


def check_spans(path: Path, report):
    out = {'file': str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else path.name}
    if not path.exists():
        return {**out, 'ok': False, 'problems': ['no spans file']}
    res = subprocess.run(['node', '--experimental-strip-types', '--no-warnings', 'scripts/verify-observability.mjs', str(path), '--report', '/dev/null'],
                         cwd=ROOT, capture_output=True, text=True)
    m = re.search(r'(\d+) spans, (\d+) runs, model (\d+), tool (\d+) \(retrieval (\d+)\), policy (\d+)', res.stdout)
    stats = dict(zip(['spans', 'runs', 'model', 'tool', 'retrieval', 'policy'], map(int, m.groups()))) if m else {}
    problems = [] if res.returncode == 0 else [l.strip() for l in res.stdout.splitlines() if l.strip()][-3:]
    text = path.read_text(errors='ignore')
    keys = [v for p in PROVIDERS.values() if p.get('api_key_env') and (v := os.environ.get(p['api_key_env'])) and len(v) >= 8]
    if CREDENTIAL.search(text) or any(k in text for k in keys):
        problems.append('credential-shaped value or provider key in spans')
    expected_runs = 2 * len(report['cases'])
    if stats.get('runs', 0) < expected_runs:
        problems.append(f'spans cover {stats.get("runs", 0)} runs, expected {expected_runs} (both arms of every pair)')
    if not stats.get('model'):
        problems.append('no model spans')
    return {**out, **stats, 'ok': not problems, 'problems': problems}


def check_run(name: str, d: Path, compare: dict | None):
    report = json.loads((d / 'report.json').read_text())
    problems = []
    errs = schema_errors(report)
    if errs:
        problems.append(f'report schema: {errs[0]}')
    agent = report.get('agent') or {}
    if agent.get('name') != 'goose':
        problems.append('report does not name goose as the agent')
    v = report['summary']['validity']
    for det in v['invalid_detail']:
        codes = set((det.get('baseline_failures') or []) + (det.get('defended_failures') or []))
        if not codes <= PROVIDER_FAULTS:
            problems.append(f'{det.get("case_id")}: invalid for a non-provider reason {sorted(codes - PROVIDER_FAULTS)}')
    invalid = {d_['case_id'] for d_ in v['invalid_detail']}
    unevaluated, bad_traces = [], []
    for c in report['cases']:
        if c['case_id'] in invalid:
            continue
        for arm in ARMS:
            if not c[arm].get('evaluation'):
                unevaluated.append(f'{c["case_id"]} {arm}')
            if not ((c[arm].get('external') or {}).get('trace') or {}).get('valid'):
                bad_traces.append(f'{c["case_id"]} {arm}')
    if unevaluated:
        problems.append(f'valid runs without an evaluator verdict: {unevaluated[:4]}')
    if bad_traces:
        problems.append(f'valid runs whose TB-004 trace did not validate: {bad_traces[:4]}')
    contract = paired.check((d / 'report.json').resolve())
    if not contract['ok']:
        problems.append(f'contract checks: {contract["problems"][:3]}')
    spans = check_spans(d / 'spans.jsonl', report)
    if not spans['ok']:
        problems.append(f'spans: {spans["problems"][:3]}')
    same = None
    if compare is not None:
        other = {(c['case_id'], c['repetition']): c for c in compare['cases']}
        diffs = [c['case_id'] for c in report['cases'] if any(verdict(c, a) != verdict(other[(c['case_id'], c['repetition'])], a) for a in ARMS)]
        same = {'cases': len(report['cases']), 'identical': len(report['cases']) - len(diffs), 'different': diffs}
        if diffs:
            problems.append(f'verdicts differ from the built-in agent: {diffs[:4]}')
    s = report['summary']
    return {'name': name, 'dir': str(d.relative_to(ROOT)) if d.resolve().is_relative_to(ROOT) else d.name, 'mode': report.get('mode'), 'model': report.get('model'),
            'agent': {k: agent.get(k) for k in ('name', 'version', 'contract_version')}, 'pairs': v['total_pairs'], 'valid_pairs': v['valid_pairs'], 'invalid_pairs': v['invalid_pairs'],
            'invalid_detail': v['invalid_detail'], 'sealed_fixtures_loaded': report.get('sealed_fixtures_loaded'),
            'rates': {k: {a: s[k][a]['rate'] for a in ARMS} for k in ('benign_utility_pass', 'unsafe_committed_effect') if k in s},
            'schema_valid': not errs, 'contract': {'ok': contract['ok'], 'runs_checked': contract.get('runs_checked'), 'denials_checked': contract.get('denials_checked')},
            'spans': spans, 'verdicts_vs_builtin': same, 'problems': problems, 'ok': not problems and v['valid_pairs'] > 0}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', action='append', required=True, help='NAME=DIR')
    ap.add_argument('--compare', help='NAME=DIR of the built-in agent on the same scripted suite, checked against the first run')
    ap.add_argument('--out', type=Path)
    a = ap.parse_args()
    cmp = json.loads((ROOT / a.compare.split('=', 1)[1] / 'report.json').read_text()) if a.compare else None
    results = []
    for i, r in enumerate(a.run):
        name, d = r.split('=', 1)
        results.append(check_run(name, (ROOT / d) if not Path(d).is_absolute() else Path(d), cmp if i == 0 else None))
    out = {'task_id': 'TB-060', 'checked_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'runs': results, 'ok': all(r['ok'] for r in results)}
    if a.out:
        a.out.write_text(json.dumps(out, indent=1) + '\n')
    for r in results:
        print(f"{'ok  ' if r['ok'] else 'FAIL'} {r['name']}: {r['valid_pairs']}/{r['pairs']} valid, schema {r['schema_valid']}, contract {r['contract']['ok']}, spans {r['spans'].get('spans')} (model {r['spans'].get('model')}, runs {r['spans'].get('runs')}){'' if r['ok'] else ' ' + '; '.join(r['problems'])[:300]}")
    return 0 if out['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
