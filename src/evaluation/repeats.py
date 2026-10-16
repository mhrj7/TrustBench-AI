"""Repeated-run evaluator (TB-028).

Fixed task-seed schedules and per-task repeated-run statistics. A unit is the registry's experimental unit
(task_id, attack_variant_id, repetition); a cluster is (task_id, attack_variant_id). Repeats of one cluster are
correlated observations, so every rate is reported per cluster first (success frequency, all-repeats success, any
success) and summarized over clusters; uncertainty is a cluster bootstrap, never a binomial over pooled runs. Results are
computed from units sorted by key, so the order in which runs were executed or listed cannot change pairing,
denominators or any number.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
from src.splits import sealed_fixture_ids  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def _json(path: str | Path) -> Any:
    return json.loads((ROOT / path).read_text())


def registry() -> dict[str, Any]:
    return _json('protocol/experiment-registry.yaml')


def config() -> dict[str, Any]:
    return _json('configs/repeats.yaml')


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def unit_of(case: dict[str, Any], variant_none: str) -> tuple[str, str]:
    """(task_id, attack_variant_id) from a case's fixture id 'TASK' or 'TASK--ATTACK'."""
    task, _, attack = case['fixture_id'].partition('--')
    return task, (case.get('attack_id') or attack or variant_none)


def build_schedule(cases: list[dict[str, Any]], *, repetitions: int | None = None, order_seed: int | None = None) -> dict[str, Any]:
    """A fixed task-seed schedule: every (case, repetition) unit with its registered run seed, in a seeded order."""
    reg, cfg = registry(), config()
    run_cfg = _json('configs/live-run.yaml')['live']
    k = reg['repetitions_per_pair'] if repetitions is None else repetitions
    base = reg['pair_order_seed']
    entries = []
    for case in sorted(cases, key=lambda c: c['case_id']):
        task, variant = unit_of(case, cfg['benign_variant_id'])
        for rep in range(1, k + 1):
            entries.append({'unit_id': f'{task}|{variant}|r{rep}', 'task_id': task, 'attack_variant_id': variant, 'case_id': case['case_id'],
                            'kind': case['kind'], 'repetition': rep, 'seed': base + rep * run_cfg['seed_offset_per_repetition']})
    ids = [e['unit_id'] for e in entries]
    if len(set(ids)) != len(ids):
        raise ValueError('two cases map to the same (task, attack variant): units must be unique')
    seed = base + cfg['order_seed_offset'] if order_seed is None else order_seed
    order = np.random.default_rng(seed).permutation(len(entries))
    ordered = [dict(entries[i], position=pos) for pos, i in enumerate(order)]
    content = sorted((e for e in entries), key=lambda e: e['unit_id'])
    return {'schema_version': '1.0.0', 'repetitions': k, 'order_seed': seed,
            'content_sha256': hashlib.sha256(canonical(content).encode()).hexdigest(),
            'order_sha256': hashlib.sha256(canonical([e['unit_id'] for e in ordered]).encode()).hexdigest(),
            'entries': ordered}


def load_runs(reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One record per (unit, arm) from arm-comparison reports; duplicates are an error, never silently merged."""
    variant_none = config()['benign_variant_id']
    out, seen = [], set()
    for report in reports:
        for case in report['cases']:
            task, variant = unit_of(case, variant_none)
            unit = f"{task}|{variant}|r{case['repetition']}"
            for arm in ('baseline', 'defended'):
                key = (report.get('defended_system') or report.get('defended_variant') or 'capability_only', unit, arm)  # older reports name only the gateway variant
                if key in seen:
                    raise ValueError(f'duplicate run for {key}')
                seen.add(key)
                side, ev = case[arm], case[arm]['evaluation']
                out.append({'system': key[0], 'unit_id': unit, 'task_id': task, 'attack_variant_id': variant, 'repetition': case['repetition'],
                            'kind': case['kind'], 'arm': arm, 'valid': not side['invalid'], 'utility_pass': bool(ev['utility_pass']),
                            'security_pass': bool(ev['security_pass']), 'attacker_goal_achieved': bool(ev['attacker_goal_achieved'])})
    return out


def _cluster_bootstrap(per_cluster: np.ndarray, resamples: int, seed: int) -> list[float] | None:
    """Percentile 95% interval of the mean over clusters, resampling whole clusters."""
    n = per_cluster.shape[0]
    if n == 0:
        return None
    draws = np.random.default_rng(seed).integers(0, n, size=(resamples, n))
    means = per_cluster[draws].mean(axis=1)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return [round(float(lo), 4), round(float(hi), 4)]


def _icc(groups: list[np.ndarray]) -> float | None:
    """One-way ANOVA intra-cluster correlation of binary outcomes (how correlated repeats of one cluster are)."""
    groups = [g for g in groups if g.size >= 2]
    if len(groups) < 2:
        return None
    k = np.array([g.size for g in groups], float)
    n, a = k.sum(), len(groups)
    grand = np.concatenate(groups).mean()
    msb = sum(g.size * (g.mean() - grand) ** 2 for g in groups) / (a - 1)
    msw = sum(((g - g.mean()) ** 2).sum() for g in groups) / (n - a)
    k0 = (n - (k ** 2).sum() / n) / (a - 1)
    denom = msb + (k0 - 1) * msw
    return None if denom == 0 else round(float((msb - msw) / denom), 4)


def evaluate(runs: list[dict[str, Any]], schedule: dict[str, Any] | None = None) -> dict[str, Any]:
    reg, cfg = registry(), config()
    resamples, seed = reg['uncertainty']['bootstrap_resamples'], reg['pair_order_seed']
    runs = sorted(runs, key=lambda r: (r['system'], r['unit_id'], r['arm']))
    expected = sorted(e['unit_id'] for e in schedule['entries']) if schedule else None
    result: dict[str, Any] = {'schema_version': '1.0.0', 'schedule_content_sha256': schedule['content_sha256'] if schedule else None, 'systems': {}}
    for system in sorted({r['system'] for r in runs}):
        rs = [r for r in runs if r['system'] == system]
        units = sorted({r['unit_id'] for r in rs})
        integrity = {'units_observed': len(units)}
        if expected is not None:
            integrity.update(units_expected=len(expected), missing_units=sorted(set(expected) - set(units)), unscheduled_units=sorted(set(units) - set(expected)))
        sys_out: dict[str, Any] = {'integrity': integrity, 'metrics': {}}
        for metric, spec in cfg['metrics'].items():
            kind = 'benign' if metric == 'benign' else 'attack'
            outcome = (lambda r, f=spec['field'], inv=spec.get('invert', False): (not r[f]) if inv else r[f])
            clusters = sorted({(r['task_id'], r['attack_variant_id']) for r in rs if r['kind'] == kind})
            m: dict[str, Any] = {'success_means': spec['success_means'], 'clusters': []}
            per_arm: dict[str, dict[str, Any]] = {}
            for arm in ('baseline', 'defended'):
                freqs, alls, anys, groups, invalid = [], [], [], [], 0
                for task, variant in clusters:
                    xs = [r for r in rs if r['arm'] == arm and r['task_id'] == task and r['attack_variant_id'] == variant]
                    valid = np.array([outcome(r) for r in sorted(xs, key=lambda r: r['repetition']) if r['valid']], float)
                    invalid += sum(not r['valid'] for r in xs)
                    if valid.size == 0:
                        continue
                    freqs.append(valid.mean()); alls.append(float(valid.min() == 1)); anys.append(float(valid.max() == 1)); groups.append(valid)
                f, a_, y = np.array(freqs), np.array(alls), np.array(anys)
                pooled = np.concatenate(groups) if groups else np.array([])
                per_arm[arm] = {
                    'clusters_with_valid_repeats': int(f.size), 'valid_repeats': int(pooled.size), 'invalid_repeats_excluded': invalid,
                    'mean_success_frequency': round(float(f.mean()), 4) if f.size else None, 'mean_success_frequency_ci95': _cluster_bootstrap(f, resamples, seed),
                    'all_repeats_success_rate': round(float(a_.mean()), 4) if a_.size else None, 'all_repeats_success_ci95': _cluster_bootstrap(a_, resamples, seed),
                    'any_repeat_success_rate': round(float(y.mean()), 4) if y.size else None,
                    'pooled_run_rate_not_for_inference': round(float(pooled.mean()), 4) if pooled.size else None,
                    'intra_cluster_correlation': _icc(groups),
                    'clusters_with_mixed_outcomes': int(sum(0 < g.mean() < 1 for g in groups)),
                }
            # Per-cluster detail, keyed by cluster id (order-free).
            for task, variant in clusters:
                row = {'task_id': task, 'attack_variant_id': variant}
                for arm in ('baseline', 'defended'):
                    xs = sorted((r for r in rs if r['arm'] == arm and r['task_id'] == task and r['attack_variant_id'] == variant), key=lambda r: r['repetition'])
                    v = [outcome(r) for r in xs if r['valid']]
                    row[arm] = {'successes': int(sum(v)), 'valid_repeats': len(v), 'invalid_repeats': sum(not r['valid'] for r in xs), 'outcomes_by_repetition': [None if not r['valid'] else bool(outcome(r)) for r in xs]}
                m['clusters'].append(row)
            # Paired difference by cluster (defended minus baseline success frequency), clusters valid in both arms.
            diffs = []
            for row in m['clusters']:
                b, d = row['baseline'], row['defended']
                if b['valid_repeats'] and d['valid_repeats']:
                    diffs.append(d['successes'] / d['valid_repeats'] - b['successes'] / b['valid_repeats'])
            dd = np.array(diffs, float)
            m['arms'] = per_arm
            m['paired_difference'] = {'clusters': int(dd.size), 'mean_frequency_difference': round(float(dd.mean()), 4) if dd.size else None,
                                      'ci95_cluster_bootstrap': _cluster_bootstrap(dd, resamples, seed)}
            sys_out['metrics'][metric] = m
        result['systems'][system] = sys_out
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('schedule', help='write a fixed task-seed schedule for a case suite')
    s.add_argument('--suite', required=True); s.add_argument('--out', required=True); s.add_argument('--repetitions', type=int); s.add_argument('--order-seed', type=int)
    s.add_argument('--live-only', action='store_true', help='drop scripted-only cases')
    s.add_argument('--confirmatory-holdout', action='store_true', help='TB-032 (A-025): schedule the registered holdout suite, holdout cases only')
    e = sub.add_parser('evaluate', help='evaluate arm-comparison reports')
    e.add_argument('--reports', nargs='+', required=True); e.add_argument('--schedule'); e.add_argument('--out', required=True)
    args = parser.parse_args()
    if args.cmd == 'schedule':
        holdout = sealed_fixture_ids()
        is_holdout = lambda c: c['fixture_id'].split('--')[0] in holdout or c.get('attack_id') in holdout
        if args.confirmatory_holdout:
            reg = registry()
            registered = {reg['holdout']['confirmatory_suite'], *reg.get('holdout2', {}).get('suites', {}).values()}
            if Path(args.suite).as_posix() not in registered:
                raise SystemExit('--confirmatory-holdout schedules only a registered holdout suite')
            cases = _json(args.suite)['cases']
            if not cases or not all(is_holdout(c) for c in cases):
                raise SystemExit('the confirmatory suite must contain holdout cases only')
        else:
            cases = [c for c in _json(args.suite)['cases'] if not (args.live_only and c.get('scripted_only')) and not is_holdout(c)]
        sched = build_schedule(cases, repetitions=args.repetitions, order_seed=args.order_seed)
        (ROOT / args.out).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / args.out).write_text(json.dumps(sched, indent=1) + '\n')
        print(json.dumps({'units': len(sched['entries']), 'content_sha256': sched['content_sha256'], 'order_sha256': sched['order_sha256']}))
    else:
        reports = [_json(p) for p in args.reports]
        out = evaluate(load_runs(reports), _json(args.schedule) if args.schedule else None)
        out['reports'] = sorted(args.reports)
        (ROOT / args.out).write_text(json.dumps(out, indent=1, sort_keys=True) + '\n')
        print(json.dumps({s: v['integrity'] for s, v in out['systems'].items()}))


if __name__ == '__main__':
    main()
