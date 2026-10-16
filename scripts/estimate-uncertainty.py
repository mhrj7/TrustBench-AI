#!/usr/bin/env python3
"""TB-034: uncertainty and repeatability for the confirmatory holdout comparisons.

For each analysis (holdout-1 per rendering, holdout-2 per rendering, and the pre-declared holdout-1 + holdout-2 pool on
the primary rendering): every endpoint in configs/uncertainty.yaml as per-arm rates with Wilson 95% intervals, the paired
difference (defended minus baseline) with a cluster bootstrap that resamples whole (task, attack variant) clusters with
their repetitions, the exact McNemar test on discordant pairs (supporting only), a one-sided upper bound wherever zero
events were observed, per-attack and per-workflow slices, paired latency and token differences, and TB-028
repeatability (all-repeat success, intra-cluster correlation). Writes reports/uncertainty.json and docs/uncertainty.md.

  estimate-uncertainty.py               every analysis (needs evidence/tb032-holdout-run.json and tb032-holdout2-run.json)
  estimate-uncertainty.py --holdout1-only   holdout-1 analyses only (for testing before holdout-2 exists; writes nothing)"""
import json, sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.stats import beta, binomtest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.evaluation.repeats import evaluate as repeatability, load_runs  # noqa: E402

CFG = json.loads((ROOT / 'configs/uncertainty.yaml').read_text())
REG = json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())
B = REG['uncertainty']['bootstrap_resamples']
SEED = REG['pair_order_seed'] + CFG['seed_offset']
LEVEL = CFG['confidence_level']
SPLITS = json.loads((ROOT / 'data/splits.json').read_text())
WORKFLOW = {f['fixture_id']: f['workflow'] for f in map(json.loads, filter(str.strip, (ROOT / 'data/benign.jsonl').read_text().splitlines()))}
GROUP_FAMILIES = {fid: sorted(g.get('attack_family_ids', []) + g.get('reused_attack_family_ids', [])) for g in SPLITS['groups'] for fid in g['fixture_ids']}

OUTCOME = {
    'not security_pass': lambda e: not e['security_pass'],
    'utility_pass': lambda e: bool(e['utility_pass']),
    'attacker_goal_achieved': lambda e: bool(e['attacker_goal_achieved']),
    'security_pass and utility_pass': lambda e: bool(e['security_pass']) and bool(e['utility_pass']),
}


def cluster_of(c):
    return (c['fixture_id'].split('--')[0], c.get('attack_id') or 'none')


def wilson(k, n):
    if not n:
        return None
    ci = binomtest(k, n).proportion_ci(confidence_level=LEVEL, method='wilson')
    return [round(ci.low, 4), round(ci.high, 4)]


def zero_bound(k, n):
    """One-sided exact (Clopper-Pearson) upper bound when no event was observed: zero observed is not zero risk."""
    if n == 0 or k != 0:
        return None
    return round(float(beta.ppf(CFG['zero_observed_one_sided_level'], 1, n)), 4)


def cluster_bootstrap(values_by_cluster):
    """Percentile interval of the pooled mean, resampling whole clusters (all their repetitions together)."""
    keys = sorted(values_by_cluster)
    sums = np.array([float(np.sum(values_by_cluster[k])) for k in keys])
    counts = np.array([len(values_by_cluster[k]) for k in keys], dtype=float)
    if len(keys) < 2:
        return None
    rng = np.random.default_rng(SEED)
    idx = rng.integers(0, len(keys), size=(B, len(keys)))
    dist = sums[idx].sum(axis=1) / counts[idx].sum(axis=1)
    a = (1 - LEVEL) / 2
    return [round(float(np.quantile(dist, a)), 4), round(float(np.quantile(dist, 1 - a)), 4)]


def endpoint(pairs, spec):
    f = OUTCOME[spec['outcome']]
    rows = [c for c in pairs if c['kind'] == spec['kind']]
    out = {'pairs': len(rows), 'clusters': len({cluster_of(c) for c in rows})}
    for arm in ('baseline', 'defended'):
        k = sum(f(c[arm]['evaluation']) for c in rows)
        out[arm] = {'numerator': k, 'denominator': len(rows), 'rate': round(k / len(rows), 4) if rows else None, 'wilson95': wilson(k, len(rows)),
                    'zero_observed_upper95_one_sided': zero_bound(k, len(rows))}
    by = defaultdict(list)
    for c in rows:
        by[cluster_of(c)].append(float(f(c['defended']['evaluation'])) - float(f(c['baseline']['evaluation'])))
    point = float(np.mean([x for v in by.values() for x in v])) if rows else None
    out['paired_difference'] = {'point': None if point is None else round(point, 4), 'cluster_bootstrap95': cluster_bootstrap(by),
                                'note': None if len(by) >= 2 else 'fewer than two clusters: no between-cluster interval'}
    b = sum(f(c['baseline']['evaluation']) and not f(c['defended']['evaluation']) for c in rows)
    d = sum(not f(c['baseline']['evaluation']) and f(c['defended']['evaluation']) for c in rows)
    out['mcnemar_exact'] = {'baseline_only': b, 'defended_only': d, 'p_value': round(float(binomtest(min(b, d), b + d, 0.5).pvalue), 6) if b + d else None,
                            'note': 'Supporting only: repetitions within a cluster are not independent, so the interval above is the inferential result.'}
    return out


def descriptive(pairs):
    out = {}
    for name in CFG['descriptive_paired']:
        get = (lambda s, n=name: s.get(n)) if name in ('elapsed_ms', 'tool_calls') else (lambda s, n=name: s['tokens'][n.removesuffix('_tokens')])
        rows = [c for c in pairs if get(c['baseline']) is not None and get(c['defended']) is not None]
        arms = {arm: {f'p{q}': round(float(np.percentile([get(c[arm]) for c in rows], q)), 1) for q in CFG['descriptive_percentiles']} for arm in ('baseline', 'defended')} if rows else {}
        by = defaultdict(list)
        for c in rows:
            by[cluster_of(c)].append(float(get(c['defended'])) - float(get(c['baseline'])))
        diffs = [x for v in by.values() for x in v]
        out[name] = {'n': len(rows), **arms, 'paired_difference_mean': round(float(np.mean(diffs)), 1) if diffs else None,
                     'paired_difference_mean_cluster_bootstrap95': cluster_bootstrap(by), 'paired_difference_median': round(float(np.median(diffs)), 1) if diffs else None}
    return out


def analyse(label, reports, role):
    cases = [c for r in reports for c in r['cases']]
    valid = [c for c in cases if not c['baseline']['invalid'] and not c['defended']['invalid']]
    invalid = [f"{c['case_id']}#r{c['repetition']}" for c in cases if c not in valid]
    out = {'analysis': label, 'role': role, 'pairs': len(cases), 'valid_pairs': len(valid), 'invalid_pairs_excluded': invalid,
           'endpoints': {name: endpoint(valid, spec) for name, spec in CFG['endpoints'].items()}}
    attack_ids = sorted({c['attack_id'] for c in valid if c['attack_id']})
    out['per_attack_slice'] = {a: {'families_of_its_group': GROUP_FAMILIES.get(a, []), 'workflow': WORKFLOW[next(c for c in valid if c['attack_id'] == a)['fixture_id'].split('--')[0]],
                                   **{k: endpoint([c for c in valid if c['attack_id'] == a], CFG['endpoints'][k]) for k in ('unsafe_committed_effect', 'attacker_goal_achieved')}}
                               for a in attack_ids}
    out['per_workflow_slice'] = {w: {k: endpoint([c for c in valid if WORKFLOW[c['fixture_id'].split('--')[0]] == w], spec) for k, spec in CFG['endpoints'].items()}
                                 for w in sorted({WORKFLOW[c['fixture_id'].split('--')[0]] for c in valid})}
    out['slices_note'] = 'Slices are exploratory except where A-026 pre-declared them; each attack is one cluster, so per-attack rows carry no between-cluster interval.'
    out['descriptive'] = descriptive(valid)
    rep = repeatability(load_runs(reports))
    out['repeatability'] = {system: {m: {'arms': v['arms'], 'paired_cluster_frequency_difference': v['paired_difference']} for m, v in s['metrics'].items()} for system, s in rep['systems'].items()}
    return out


def holdout1_reports():
    rec = json.loads((ROOT / 'evidence/tb032-holdout-run.json').read_text())
    return [(x['rendering'], [json.loads((ROOT / x['report']).read_text())], x['role']) for x in rec['renderings']]


def holdout2_reports():
    rec = json.loads((ROOT / 'evidence/tb032-holdout2-run.json').read_text())
    if not rec['complete']:
        sys.exit('holdout-2 run record is not complete')
    by = defaultdict(list)
    role = {}
    for x in rec['renderings']:
        by[x['rendering']].append(json.loads((ROOT / x['report']).read_text()))
        role[x['rendering']] = x['role']
    return [(r, reps, role[r]) for r, reps in by.items()]


def main():
    primary = json.loads((ROOT / 'configs/frozen/selection.json').read_text())['data']['selection_condition']['attack_rendering']
    analyses = [analyse(f'holdout1/{r}', reps, role) for r, reps, role in holdout1_reports()]
    if '--holdout1-only' in sys.argv:
        print(json.dumps({a['analysis']: a['endpoints']['unsafe_committed_effect']['paired_difference'] for a in analyses}))
        return analyses
    h2 = holdout2_reports()
    analyses += [analyse(f'holdout2/{r}', reps, role) for r, reps, role in h2]
    h1p = next(reps for r, reps, _ in holdout1_reports() if r == primary)
    h2p = next(reps for r, reps, _ in h2 if r == primary)
    analyses.append(analyse(f'pooled holdout1+holdout2/{primary}', h1p + h2p, 'primary (pre-declared pool, A-026)'))
    out = {'task_id': 'TB-034', 'rule': 'protocol/preregister.md (uncertainty); A-025; A-026', 'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
           'bootstrap': {'resamples': B, 'seed': SEED, 'cluster': REG['uncertainty']['bootstrap_cluster'], 'interval': 'percentile', 'level': LEVEL},
           'cost': CFG['cost_note'], 'analyses': analyses}
    (ROOT / CFG['outputs']['json']).write_text(json.dumps(out, indent=1) + '\n')
    write_doc(out, primary)
    print(json.dumps({a['analysis']: (a['endpoints']['unsafe_committed_effect']['paired_difference'], a['endpoints']['benign_utility_pass']['paired_difference']['point']) for a in analyses}))
    return analyses


def write_doc(out, primary):
    pp = lambda x: '—' if x is None else f'{x * 100:+.1f} pp'
    ci = lambda x: '—' if not x else f'[{x[0] * 100:+.1f}, {x[1] * 100:+.1f}]'
    rt = lambda a: '—' if a['rate'] is None else f"{a['numerator']}/{a['denominator']} ({a['rate'] * 100:.1f}%)" + (f", ≤{a['zero_observed_upper95_one_sided'] * 100:.1f}% one-sided 95%" if a['zero_observed_upper95_one_sided'] is not None else '')
    L = ['# Uncertainty and repeatability (TB-034)', '',
         f"Generated by `scripts/estimate-uncertainty.py`. Paired cluster bootstrap: {out['bootstrap']['resamples']} resamples of whole (task, attack variant) clusters with their "
         f"repetitions, seed {out['bootstrap']['seed']}, percentile 95% interval. Exact McNemar is supporting only. Where no event was observed the one-sided 95% upper bound is shown: "
         'zero observed is not zero risk.', '', '## Co-primary endpoints', '',
         '| Analysis | Role | Endpoint | Baseline | Defended | Paired difference | 95% cluster bootstrap | Clusters | McNemar p |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for a in out['analyses']:
        for name in ('unsafe_committed_effect', 'benign_utility_pass'):
            e = a['endpoints'][name]
            if not e['pairs']:
                continue
            L.append(f"| {a['analysis']} | {a['role']} | {name.replace('_', ' ')} | {rt(e['baseline'])} | {rt(e['defended'])} | {pp(e['paired_difference']['point'])} | "
                     f"{ci(e['paired_difference']['cluster_bootstrap95'])} | {e['clusters']} | {e['mcnemar_exact']['p_value'] if e['mcnemar_exact']['p_value'] is not None else '—'} |")
    L += ['', '## Reading against the pre-registered rule', '']
    for a in out['analyses']:
        if not a['role'].startswith('primary'):
            continue
        u, b = a['endpoints']['unsafe_committed_effect']['paired_difference'], a['endpoints']['benign_utility_pass']['paired_difference']
        sec = u['cluster_bootstrap95'] and u['cluster_bootstrap95'][1] < 0
        util_lo = b['cluster_bootstrap95'][0] if b['cluster_bootstrap95'] else None
        L.append(f"- **{a['analysis']}**: unsafe difference {pp(u['point'])} {ci(u['cluster_bootstrap95'])} — the interval {'excludes' if sec else 'does not exclude'} zero; "
                 f"benign utility difference {pp(b['point'])} {ci(b['cluster_bootstrap95'])} — the lower bound is {'above' if util_lo is not None and util_lo >= -REG['utility_noninferiority_margin_percentage_points'] / 100 else 'below'} "
                 f"the −{REG['utility_noninferiority_margin_percentage_points']} pp margin.")
    L += ['', '## Per-attack slices (exploratory unless pre-declared; one cluster each)', '', '| Analysis | Attack | Workflow | Families of its group | Unsafe baseline | Unsafe defended | McNemar p |', '| --- | --- | --- | --- | --- | --- | --- |']
    for a in out['analyses']:
        if a['analysis'].startswith('pooled'):
            continue
        for aid, s in a['per_attack_slice'].items():
            e = s['unsafe_committed_effect']
            L.append(f"| {a['analysis']} | {aid} | {s['workflow']} | {', '.join(s['families_of_its_group'])} | {rt(e['baseline'])} | {rt(e['defended'])} | {e['mcnemar_exact']['p_value'] if e['mcnemar_exact']['p_value'] is not None else '—'} |")
    L += ['', '## Latency and tokens (paired, defended minus baseline)', '', '| Analysis | Measure | Baseline p50 / p95 | Defended p50 / p95 | Mean difference | 95% cluster bootstrap | Median difference |', '| --- | --- | --- | --- | --- | --- | --- |']
    for a in out['analyses']:
        for m, d in a['descriptive'].items():
            if not d['n']:
                continue
            L.append(f"| {a['analysis']} | {m} | {d['baseline']['p50']} / {d['baseline']['p95']} | {d['defended']['p50']} / {d['defended']['p95']} | {d['paired_difference_mean']} | "
                     f"{d['paired_difference_mean_cluster_bootstrap95'] or '—'} | {d['paired_difference_median']} |")
    L += ['', f"Cost: {out['cost']}", '', '## Repeatability (TB-028 measures over 5 repetitions)', '',
          '| Analysis | Measure | Arm | Mean success frequency | All-repeats success | Clusters with mixed outcomes | ICC |', '| --- | --- | --- | --- | --- | --- | --- |']
    for a in out['analyses']:
        for system, ms in a['repeatability'].items():
            for m, v in ms.items():
                for arm, x in v['arms'].items():
                    if not x['clusters_with_valid_repeats']:
                        continue
                    L.append(f"| {a['analysis']} | {m} | {arm} | {x['mean_success_frequency']} | {x['all_repeats_success_rate']} | {x['clusters_with_mixed_outcomes']}/{x['clusters_with_valid_repeats']} | {x['intra_cluster_correlation']} |")
    L += ['', 'Limitations: holdout-1 has 3 attack and 3 benign clusters per rendering, holdout-2 has 12 of each, so between-cluster intervals rest on few clusters; '
          'the bootstrap cannot represent variation from tasks that were never sampled. Holdout-2 was authored after holdout-1 aggregates were seen (A-026 disclosure).', '']
    (ROOT / CFG['outputs']['doc']).write_text('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
