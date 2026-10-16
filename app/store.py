"""Versioned run store for the review dashboard (TB-030).

The store is the set of live evidence reports, the TB-029 attribution file and the TB-027 span files, pinned by an index
of content hashes (reports/dashboard/run-index.json, written by scripts/dashboard-index.py). The store version is the
SHA-256 of that list, so a dashboard view names exactly the evidence it shows. Loading re-hashes every file and reports any
change since the index was built. Every run keeps its source: report path, report SHA-256 and JSON pointer."""
from __future__ import annotations

import csv
import glob
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
INDEX_SCHEMA = '1.0.0'


def load_config() -> dict[str, Any]:
    return json.loads((ROOT / 'configs/dashboard.yaml').read_text())


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _git_commit() -> str | None:
    try:
        return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def _entries(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for p in sorted(glob.glob(str(ROOT / cfg['report_glob']))):
        path = Path(p)
        rep = json.loads(path.read_bytes())
        if rep.get('mode') != cfg['report_mode']:
            continue
        rel = str(path.relative_to(ROOT))
        out.append({'kind': 'report', 'path': rel, 'sha256': sha256_file(path), 'bytes': path.stat().st_size,
                    'schema_version': rep.get('schema_version'), 'runs': 2 * len(rep['cases'])})
        if rep.get('trace_file') and (ROOT / rep['trace_file']).exists():
            out.append({'kind': 'spans', 'path': rep['trace_file'], 'sha256': sha256_file(ROOT / rep['trace_file']), 'report': rel})
    att = ROOT / cfg['attribution_file']
    if att.exists():
        loc = json.loads((ROOT / 'configs/localization.yaml').read_text())['schema_version']
        out.append({'kind': 'attribution', 'path': cfg['attribution_file'], 'sha256': sha256_file(att), 'localizer_version': loc})
    return out


def store_version(entries: list[dict[str, Any]]) -> str:
    canon = json.dumps([[e['kind'], e['path'], e['sha256']] for e in entries], separators=(',', ':'))
    return hashlib.sha256(canon.encode()).hexdigest()


def build_index(cfg: dict[str, Any]) -> dict[str, Any]:
    entries = _entries(cfg)
    return {'schema_version': INDEX_SCHEMA, 'task_id': 'TB-030', 'store_version': store_version(entries), 'git_commit': _git_commit(),
            'report_glob': cfg['report_glob'], 'report_mode': cfg['report_mode'], 'entries': entries}


def verify_index(index: dict[str, Any], cfg: dict[str, Any]) -> list[str]:
    """Differences between the indexed store and the files on disk now (empty when the store is unchanged)."""
    problems = []
    indexed = {(e['kind'], e['path']): e['sha256'] for e in index['entries']}
    current = {(e['kind'], e['path']): e['sha256'] for e in _entries(cfg)}
    for key, sha in indexed.items():
        if key not in current:
            problems.append(f'missing since indexing: {key[1]}')
        elif current[key] != sha:
            problems.append(f'changed since indexing: {key[1]}')
    problems += [f'not in the index: {key[1]}' for key in current if key not in indexed]
    return problems


def _system(rep: dict[str, Any], arm: str) -> str:
    # Same naming as scripts/attribute-failures.py, so runs join with reports/attribution.csv.
    return (rep.get('defended_system') or rep.get('defended_variant') or 'capability_only') if arm == 'defended' else 'baseline'


def run_id(report_path: str, case: dict[str, Any], arm: str) -> str:
    return f"{Path(report_path).name.removesuffix('-report.json')}|{case['case_id']}|r{case['repetition']}|{arm}"


def load_runs(index: dict[str, Any], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    attribution = {}
    att = next((e for e in index['entries'] if e['kind'] == 'attribution'), None)
    if att:
        with open(ROOT / att['path'], newline='') as fh:
            attribution = {r['run_id']: r for r in csv.DictReader(fh)}
    spans_of = {e['report']: e['path'] for e in index['entries'] if e['kind'] == 'spans'}
    runs = []
    for e in index['entries']:
        if e['kind'] != 'report':
            continue
        rep = json.loads((ROOT / e['path']).read_bytes())
        for i, case in enumerate(rep['cases']):
            for arm in ('baseline', 'defended'):
                side, ev = case[arm], case[arm]['evaluation']
                rid = run_id(e['path'], case, arm)
                a = attribution.get(rid, {})
                runs.append({
                    'run_id': rid, 'report': e['path'], 'report_sha256': e['sha256'], 'pointer': f'/cases/{i}/{arm}',
                    'model': rep['model'], 'system': _system(rep, arm), 'rendering': rep['attack_rendering'], 'profile': rep['prompt_profile'],
                    'kind': case['kind'], 'case_id': case['case_id'], 'fixture_id': case['fixture_id'], 'attack_id': case.get('attack_id'),
                    'repetition': case['repetition'], 'arm': arm, 'outcome': side['outcome'], 'invalid': bool(side['invalid']),
                    'utility_pass': bool(ev['utility_pass']), 'security_pass': bool(ev['security_pass']), 'attacker_goal': bool(ev['attacker_goal_achieved']),
                    'reason_codes': list(ev.get('reason_codes', [])), 'steps': len(side['tool_trace']), 'elapsed_ms': side.get('elapsed_ms'),
                    'tokens_in': (side.get('tokens') or {}).get('input'), 'tokens_out': (side.get('tokens') or {}).get('output'),
                    'policy': [[d['tool'], d['decision'], d.get('reason') or ''] for d in side.get('policy_decisions') or []],
                    'trace_errors': [[t['tool'], t['error']] for t in side['tool_trace'] if t.get('error')],
                    'spans_file': spans_of.get(e['path']),
                    'utility_rule': a.get('utility_rule') or None, 'utility_step': int(a['utility_step']) if a.get('utility_step') else None,
                    'security_rule': a.get('security_rule') or None, 'security_step': int(a['security_step']) if a.get('security_step') else None,
                    'first_rule': a.get('first_rule') or None, 'first_step': int(a['first_step']) if a.get('first_step') else None,
                })
    return runs


def raw_record(run: dict[str, Any]) -> dict[str, Any]:
    """The run's source record exactly as stored, after checking the report still has its indexed hash."""
    path = ROOT / run['report']
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != run['report_sha256']:
        raise ValueError(f"{run['report']} changed since the store was indexed")
    obj: Any = json.loads(data)
    for part in run['pointer'].strip('/').split('/'):
        obj = obj[int(part)] if isinstance(obj, list) else obj[part]
    case = json.loads(data)['cases'][int(run['pointer'].split('/')[2])]
    return {'source': {'report': run['report'], 'sha256': run['report_sha256'], 'pointer': run['pointer']},
            'case': {k: v for k, v in case.items() if k not in ('baseline', 'defended')}, 'run': obj}


def run_spans(run: dict[str, Any]) -> list[dict[str, Any]]:
    """The TB-027 spans of one run (trace attribute run.id is run-<case>-r<repetition>:<arm>), or [] when none were recorded."""
    if not run.get('spans_file'):
        return []
    key = f"run-{run['case_id']}-r{run['repetition']}:{run['arm']}"
    spans = [s for s in map(json.loads, (ROOT / run['spans_file']).read_text().splitlines()) if s['attributes'].get('run.id') == key]
    roots = [s for s in spans if s['name'] == 'agent.run']
    if len(roots) != 1 or roots[0]['attributes'].get('case.id') != run['case_id']:
        return []  # not exactly one matching run root: show the run as untimed rather than guess
    return sorted(spans, key=lambda s: (s['start_ms'], s['name'] != 'agent.run'))
