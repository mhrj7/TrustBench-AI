"""View logic for the review dashboard (TB-030), separate from Streamlit so it can be tested directly.

Every aggregate carries the IDs of the runs it counts (numerator and denominator), so the dashboard can open the raw
evidence behind any number it shows."""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Any


def wilson(k: int, n: int, z: float) -> tuple[float, float] | None:
    if n == 0:
        return None
    p, d = k / n, 1 + z * z / n
    c, h = p + z * z / (2 * n), z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (c - h) / d), min(1.0, (c + h) / d)


def apply_filters(runs: list[dict[str, Any]], selected: dict[str, list[Any]], include_invalid: bool = False) -> list[dict[str, Any]]:
    return [r for r in runs if (include_invalid or not r['invalid']) and all(not v or r[k] in v for k, v in selected.items())]


def metric_runs(runs: list[dict[str, Any]], spec: dict[str, Any]) -> list[dict[str, Any]]:
    return [r for r in runs if not r['invalid'] and (spec['kinds'] is None or r['kind'] in spec['kinds'])]


def aggregate(runs: list[dict[str, Any]], dims: list[str], metrics: dict[str, Any], z: float) -> list[dict[str, Any]]:
    """One row per combination of dims. For each metric: k, n, rate, Wilson interval and the run IDs behind k and n."""
    groups: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for r in runs:
        groups[tuple(r[d] for d in dims)].append(r)
    rows = []
    for key in sorted(groups, key=lambda k: tuple(str(x) for x in k)):
        members = groups[key]
        row = {'key': dict(zip(dims, key)), 'runs': len(members), 'run_ids': [r['run_id'] for r in members],
               'invalid_ids': [r['run_id'] for r in members if r['invalid']], 'metrics': {}}
        for name, spec in metrics.items():
            if not isinstance(spec, dict):
                continue
            counted = metric_runs(members, spec)
            hits = [r['run_id'] for r in counted if r[spec['field']]]
            ci = wilson(len(hits), len(counted), z)
            row['metrics'][name] = {'k': len(hits), 'n': len(counted), 'rate': len(hits) / len(counted) if counted else None,
                                    'ci': ci, 'hit_ids': hits, 'miss_ids': [r['run_id'] for r in counted if not r[spec['field']]]}
        rows.append(row)
    return rows


def evidence_rows(group: dict[str, Any], by_id: dict[str, dict[str, Any]], metrics: dict[str, Any]) -> list[dict[str, Any]]:
    """The runs behind one aggregate row, each with how it counted for every metric and where its raw record is."""
    out = []
    for rid in group['run_ids']:
        r = by_id[rid]
        row = {'run_id': rid, 'case': r['case_id'], 'rep': r['repetition'], 'arm': r['arm'], 'outcome': r['outcome'], 'invalid': r['invalid']}
        for name, m in group['metrics'].items():
            row[name] = 'counted: yes' if rid in m['hit_ids'] else 'counted: no' if rid in m['miss_ids'] else 'not counted'
        row.update(report=r['report'], sha256=r['report_sha256'][:12], pointer=r['pointer'])
        out.append(row)
    return out


def step_rows(record: dict[str, Any], run: dict[str, Any], is_denial) -> list[dict[str, Any]]:
    """One row per tool call: status, the error the agent received (for a denied call, the policy reason), whether that is a
    defense denial, and the TB-029 attribution markers. Gateway decisions are not matched to steps: suppressed duplicates
    never reach the gateway and retried reads reach it more than once, so the audit is shown separately in its own order."""
    marks = {('first violation', run.get('first_step')), ('utility attribution', run.get('utility_step')), ('security attribution', run.get('security_step'))}
    return [{'step': i, 'tool': t['tool'], 'status': t['status'], 'error / policy reason': t.get('error'),
             'defense denial': bool(t.get('error')) and is_denial(t.get('error')), 'attempts': t.get('attempts'),
             'attribution': ', '.join(sorted(name for name, s in marks if s == i)) or None, 'args': t.get('args')}
            for i, t in enumerate(record['run']['tool_trace'])]


def gateway_rows(record: dict[str, Any]) -> list[dict[str, Any]]:
    return [{k: d.get(k) for k in ('seq', 'tool', 'decision', 'reason', 'executed', 'replayed')} for d in record['run'].get('policy_decisions') or []]


def waterfall_spans(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Timed waterfall bars from TB-027 spans: offset from the run start, duration, kind and a short label."""
    if not spans:
        return []
    t0 = min(s['start_ms'] for s in spans)
    out = []
    for s in spans:
        a = s['attributes']
        label = {'agent.run': f"run ({a.get('run.outcome')})", 'model.call': f"model ({a.get('model.role')}, {a.get('model.finish_reason')})",
                 'tool.call': f"{a.get('tool.name')} [{a.get('tool.status')}{', ' + a['tool.error_code'] if a.get('tool.error_code') else ''}]",
                 'policy.decision': f"policy {a.get('policy.decision')}" + (f": {a['policy.reason']}" if a.get('policy.reason') else '')}.get(s['name'], s['name'])
        out.append({'span': s['name'], 'label': label, 'start_ms': s['start_ms'] - t0, 'duration_ms': max(s['duration_ms'], 0.5),
                    'queue_ms': a.get('queue.ms'), 'status': s['status']})
    return out


def policy_reasons(runs: list[dict[str, Any]], dims: list[str], source: str, is_denial=None) -> list[dict[str, Any]]:
    """Policy outcomes counted by dims and reason, with the runs that contain each. source 'gateway': the gateway's own
    audit (decision and reason per request). source 'agent': defense denials as the agent received them (tool-trace error
    codes), which also covers defenses that run outside the gateway."""
    counts: dict[tuple, dict[str, Any]] = {}
    for r in runs:
        if source == 'gateway':
            items = [(tool, decision, reason) for tool, decision, reason in r['policy']]
        else:
            items = [(tool, 'denied', err) for tool, err in r['trace_errors'] if is_denial(err)]
        for _tool, decision, reason in items:
            key = tuple(r[x] for x in dims) + (decision, reason)
            c = counts.setdefault(key, {'key': dict(zip(dims + ['decision', 'reason'], key)), 'count': 0, 'run_ids': []})
            c['count'] += 1
            if not c['run_ids'] or c['run_ids'][-1] != r['run_id']:
                c['run_ids'].append(r['run_id'])
    return sorted(counts.values(), key=lambda c: (-c['count'], str(c['key'])))


def outcome_counts(runs: list[dict[str, Any]], dims: list[str]) -> list[dict[str, Any]]:
    out: dict[tuple, dict[str, Any]] = {}
    for r in runs:
        key = tuple(r[x] for x in dims) + (r['outcome'],)
        o = out.setdefault(key, {'key': dict(zip(dims + ['outcome'], key)), 'runs': 0, 'run_ids': []})
        o['runs'] += 1
        o['run_ids'].append(r['run_id'])
    return sorted(out.values(), key=lambda o: str(o['key']))
