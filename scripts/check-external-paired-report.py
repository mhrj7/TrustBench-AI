#!/usr/bin/env python3
"""TB-057: check a paired report produced by an external agent (run-arm-smoke.mjs --agent <name>) against the integration
contract (docs/external/integration-contract.md, acceptance tests 1-5 and 7):

- the report names the pinned agent, and every run used the pinned binary;
- both arms of every pair ran the same agent configuration and the same system prompt (they differ only in the tool path);
- the model was offered only the contract's tools (prefix + TrustBench tool names) and goose's built-in load_skill;
- every run's TB-004 trace validated, and every denial in a trace carries a code the contract lists;
- no credential-shaped value, and none of the provider keys in the environment, appears in any file of the run's output.

usage: scripts/check-external-paired-report.py <report.json> [<report.json> ...] [--out evidence/...json]
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'configs/external-agents.yaml').read_text())
TOOLS = sorted(json.loads((ROOT / 'src/policy/capability-manifests.json').read_text())['argument_schemas'])
PROVIDERS = json.loads((ROOT / 'configs/providers.yaml').read_text())['providers']
CREDENTIAL = re.compile(r'Bearer\s+[A-Za-z0-9._-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}')
ARMS = ('baseline', 'defended')


def trace_path(report: Path, recorded: str) -> Path:
    for base in (ROOT, report.parent, Path.cwd()):
        p = (base / recorded).resolve()
        if p.exists():
            return p
    return report.parent / 'traces' / Path(recorded).name


def check(report_path: Path) -> dict:
    report = json.loads(report_path.read_text())
    problems: list[str] = []
    agent = report.get('agent') or {}
    spec = CFG['agents'].get(agent.get('name', ''))
    if not spec:
        return {'report': str(report_path), 'ok': False, 'problems': ['the report names no registered external agent']}
    if agent.get('version') != spec['version'] or agent.get('commit') != spec['commit']:
        problems.append('agent version or commit differs from the pinned one')
    pinned = {a['binary_sha256'] for a in spec['artifacts'].values()}
    offered = sorted([f"{spec['tool_prefix']}{t}" for t in TOOLS] + ['load_skill'])
    denial_codes = set(CFG['gateway_denial_codes']) | {CFG['trace']['unavailable_code'], CFG['trace']['cancelled_code'], CFG['trace']['connection_refused_code'], 'tool_not_allowed'}
    runs = denials = traces_remote = 0
    for case in report['cases']:
        ext = {arm: case[arm].get('external') or {} for arm in ARMS}
        tag = f"{case['case_id']} r{case['repetition']}"
        if case[ARMS[0]].get('invalid') or case[ARMS[1]].get('invalid'):
            continue  # invalid pairs are excluded from every rate; nothing to compare
        for arm in ARMS:
            e = ext[arm]
            runs += 1
            if e.get('binary_sha256') not in pinned:
                problems.append(f'{tag} {arm}: binary is not the pinned one')
            if sorted(e.get('advertised_tools') or []) != offered:
                problems.append(f'{tag} {arm}: the model was offered {e.get("advertised_tools")}')
            if not (e.get('trace') or {}).get('valid'):
                problems.append(f'{tag} {arm}: trace invalid: {(e.get("trace") or {}).get("error")}')
                continue
            tp = trace_path(report_path, e['trace']['file'])
            if not tp.exists():  # a report fetched from a service: its traces stay there; the recorded validity is checked
                traces_remote += 1
                continue
            for line in tp.read_text().splitlines():
                ev = json.loads(line)
                if ev.get('event_type') == 'policy_decision' and ev.get('decision') == 'deny':
                    denials += 1
                    if ev.get('reason_code') not in denial_codes:
                        problems.append(f'{tag} {arm}: denial code {ev.get("reason_code")} is not in the contract')
        for field in ('configuration_sha256', 'system_prompt_sha256'):
            if ext['baseline'].get(field) != ext['defended'].get(field):
                problems.append(f'{tag}: arms differ in {field}')
    keys = [v for p in PROVIDERS.values() if p.get('api_key_env') and (v := os.environ.get(p['api_key_env'])) and len(v) >= 8]
    scanned = 0
    for f in report_path.parent.rglob('*'):
        if f.is_file():
            scanned += 1
            text = f.read_text(errors='ignore')
            if CREDENTIAL.search(text) or any(k in text for k in keys):
                problems.append(f'credential-shaped value in {f.name}')
    s = report['summary']['validity']
    return {'report': str(report_path.relative_to(ROOT)) if report_path.is_relative_to(ROOT) else report_path.name,
            'agent': {k: agent.get(k) for k in ('name', 'version', 'commit')}, 'model': report.get('model'),
            'pairs': s['total_pairs'], 'valid_pairs': s['valid_pairs'], 'runs_checked': runs, 'denials_checked': denials, 'traces_checked_by_recorded_validity_only': traces_remote,
            'files_scanned_for_credentials': scanned, 'problems': problems, 'ok': not problems and runs > 0}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('reports', nargs='+', type=Path)
    ap.add_argument('--out', type=Path)
    a = ap.parse_args()
    results = [check(p.resolve()) for p in a.reports]
    out = {'task_id': 'TB-057', 'checked_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'results': results, 'ok': all(r['ok'] for r in results)}
    if a.out:
        a.out.write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps(out, indent=1))
    return 0 if out['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
