#!/usr/bin/env python3
"""TB-036 (A-027): component ablations on development data.

Reads one report per arm (configs/ablations.yaml run.arms_to_run, prefix run.report_prefix) plus the frozen system's
A-025 gate run, checks that every arm ran with identical settings, and computes:
  - per arm, defended vs its own paired baseline: unsafe committed effect and benign utility with Wilson intervals and a
    paired cluster-bootstrap interval (scripts/estimate-uncertainty.py);
  - per registered comparison (component = arm with it minus arm without it): the difference on the defended arm,
    matched by unit (case, repetition), with the same cluster bootstrap; 'baseline' as the 'without' arm means the
    within-run paired difference;
  - the A-027 reading (credited / no measurable contribution / utility cost) and the claims inventory, every claim
    either tested by a comparison or labelled untested with its reason.
Writes reports/ablations.csv, evidence/tb036-ablations.json and docs/ablations.md."""
import glob, hashlib, importlib.util, json, sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
AB = json.loads((ROOT / 'configs/ablations.yaml').read_text())
_spec = importlib.util.spec_from_file_location('uncertainty', ROOT / 'scripts/estimate-uncertainty.py')
UN = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(UN)
ENDPOINTS = {k: UN.CFG['endpoints'][k] for k in ('unsafe_committed_effect', 'benign_utility_pass')}
SAME = ('model', 'prompt_profile', 'attack_rendering', 'temperature', 'repetitions', 'suite', 'backend_tool_mode', 'mode', 'attack_channel')


def reports():
    out = {}
    for p in glob.glob(str(ROOT / f"evidence/{AB['run']['report_prefix']}-*-report.json")):
        r = json.loads(Path(p).read_text())
        if r['defended_system'] in out:
            sys.exit(f"two {AB['run']['report_prefix']} reports for {r['defended_system']}")
        out[r['defended_system']] = (str(Path(p).relative_to(ROOT)), r)
    frozen = AB['run']['frozen_arm']
    gate = json.loads((ROOT / 'evidence/release-gate-dev.json').read_text())
    out[frozen['system']] = (gate['report'], json.loads((ROOT / gate['report']).read_text()))
    missing = [s for s in AB['run']['arms_to_run'] + [frozen['system']] if s not in out]
    if missing:
        sys.exit(f'no report yet for: {", ".join(missing)}')
    ref = out[frozen['system']][1]
    for system, (path, r) in out.items():
        diff = {k: (r.get(k), ref.get(k)) for k in SAME if r.get(k) != ref.get(k)}
        rel = ({k: v for k, v in (r.get('reliability') or {}).items() if k not in ('file', 'name')}, {k: v for k, v in (ref.get('reliability') or {}).items() if k not in ('file', 'name')})
        if diff or rel[0] != rel[1]:
            sys.exit(f'{system} ran with different settings from the frozen arm: {diff or rel}')
        if r['selected_case_ids'] != ref['selected_case_ids'] or r['holdout_excluded_cases'] != ref['holdout_excluded_cases']:
            sys.exit(f'{system}: different case selection')
    return out


def valid(r):
    return {(c['case_id'], c['repetition']): c for c in r['cases'] if not c['baseline']['invalid'] and not c['defended']['invalid']}


def between(with_r, without_r, spec):
    """Defended-arm difference (with minus without) over units valid in both runs, clustered by (task, attack variant)."""
    a, b = valid(with_r), valid(without_r)
    f = UN.OUTCOME[spec['outcome']]
    by = defaultdict(list)
    for unit in sorted(set(a) & set(b)):
        if a[unit]['kind'] != spec['kind']:
            continue
        by[UN.cluster_of(a[unit])].append(float(f(a[unit]['defended']['evaluation'])) - float(f(b[unit]['defended']['evaluation'])))
    diffs = [x for v in by.values() for x in v]
    return {'matched_units': len(diffs), 'clusters': len(by), 'point': round(sum(diffs) / len(diffs), 4) if diffs else None, 'cluster_bootstrap95': UN.cluster_bootstrap(by)}


def reading(unsafe, utility):
    ci_s, ci_u = unsafe['cluster_bootstrap95'], utility['cluster_bootstrap95']
    security = ('credited: removing it raises unsafe effects' if ci_s and ci_s[1] < 0 else
                'harmful: it raises unsafe effects' if ci_s and ci_s[0] > 0 else 'no measurable contribution on development data')
    cost = 'utility cost' if ci_u and ci_u[1] < 0 else 'utility gain' if ci_u and ci_u[0] > 0 else 'no measurable utility effect'
    return security, cost


def main():
    reps = reports()
    arms, rows = {}, []
    for system, (path, r) in sorted(reps.items()):
        pairs = list(valid(r).values())
        e = {k: UN.endpoint(pairs, spec) for k, spec in ENDPOINTS.items()}
        arms[system] = {'report': path, 'sha256': hashlib.sha256((ROOT / path).read_bytes()).hexdigest(), 'pairs': len(r['cases']), 'valid_pairs': len(pairs),
                        'ablation': r.get('ablation'), 'endpoints': e, 'observed_response_models': r['model_revision']['observed_response_models']}
        for k, x in e.items():
            rows.append({'kind': 'arm', 'id': system, 'endpoint': k, 'with': system, 'without': 'its paired baseline', 'baseline_rate': x['baseline']['rate'],
                         'defended_rate': x['defended']['rate'], 'numerator_defended': x['defended']['numerator'], 'denominator': x['defended']['denominator'],
                         'difference': x['paired_difference']['point'], 'ci95_low': (x['paired_difference']['cluster_bootstrap95'] or [None, None])[0],
                         'ci95_high': (x['paired_difference']['cluster_bootstrap95'] or [None, None])[1], 'clusters': x['clusters'], 'reading': ''})
    comps = []
    for c in AB['comparisons']:
        res = {}
        for k, spec in ENDPOINTS.items():
            if c['without'] == 'baseline':
                p = arms[c['with']]['endpoints'][k]
                res[k] = {'matched_units': p['pairs'], 'clusters': p['clusters'], 'point': p['paired_difference']['point'], 'cluster_bootstrap95': p['paired_difference']['cluster_bootstrap95']}
            else:
                res[k] = between(reps[c['with']][1], reps[c['without']][1], spec)
        sec, cost = reading(res['unsafe_committed_effect'], res['benign_utility_pass'])
        comps.append({**c, 'results': res, 'security_reading': sec, 'utility_reading': cost})
        for k, x in res.items():
            rows.append({'kind': 'comparison', 'id': c['id'], 'endpoint': k, 'with': c['with'], 'without': c['without'], 'baseline_rate': None, 'defended_rate': None,
                         'numerator_defended': None, 'denominator': x['matched_units'], 'difference': x['point'], 'ci95_low': (x['cluster_bootstrap95'] or [None, None])[0],
                         'ci95_high': (x['cluster_bootstrap95'] or [None, None])[1], 'clusters': x['clusters'], 'reading': sec if k == 'unsafe_committed_effect' else cost})
    by_id = {c['id']: c for c in comps}
    claims = []
    for cl in AB['claims']:
        tested = [by_id[t] for t in cl['tested_by']]
        claims.append({**cl, 'status': 'untested by ablation' if not tested else 'tested',
                       'verdict': '; '.join(f"{t['id']}: {t['security_reading']}, {t['utility_reading']}" for t in tested) if tested else cl['untested_reason']})
    pd.DataFrame(rows).to_csv(ROOT / AB['outputs']['csv'], index=False)
    out = {'task_id': 'TB-036', 'rule': 'protocol/amendments.md A-027', 'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
           'data': 'development suite only (tuning split); estimates are optimistic because the system was designed on these data',
           'bootstrap': {'resamples': UN.B, 'seed': UN.SEED, 'cluster': UN.REG['uncertainty']['bootstrap_cluster']},
           'arms': arms, 'comparisons': comps, 'claims': claims}
    (ROOT / AB['outputs']['json']).write_text(json.dumps(out, indent=1) + '\n')
    write_doc(out)
    print(json.dumps({c['id']: (c['results']['unsafe_committed_effect']['point'], c['results']['unsafe_committed_effect']['cluster_bootstrap95'], c['security_reading'], c['utility_reading']) for c in comps}, indent=1))


def write_doc(out):
    pp = lambda x: '—' if x is None else f'{x * 100:+.1f} pp'
    ci = lambda x: '—' if not x else f'[{x[0] * 100:+.1f}, {x[1] * 100:+.1f}]'
    rt = lambda a: '—' if a['rate'] is None else f"{a['numerator']}/{a['denominator']} ({a['rate'] * 100:.1f}%)"
    L = ['# Component ablations (TB-036)', '', f"Generated by `scripts/analyse-ablations.py` under A-027. {out['data'].capitalize()}. Every arm ran with the frozen "
         'model, prompt profile, generation settings, pacing, budget and reliability override, the selection rendering and 3 repetitions; the frozen system is the A-025 '
         f"gate run. Cluster bootstrap: {out['bootstrap']['resamples']} resamples of (task, attack variant) clusters, seed {out['bootstrap']['seed']}.", '',
         '## Arms (each against its own paired baseline)', '', '| Arm | Disabled gateway layers | Unsafe baseline | Unsafe defended | Paired difference | 95% interval | Utility baseline | Utility defended | Paired difference | 95% interval |',
         '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for s, a in out['arms'].items():
        u, b = a['endpoints']['unsafe_committed_effect'], a['endpoints']['benign_utility_pass']
        layers = ', '.join(a['ablation']['disabled_gateway_layers']) if a['ablation'] else '—'
        L.append(f"| {s} | {layers} | {rt(u['baseline'])} | {rt(u['defended'])} | {pp(u['paired_difference']['point'])} | {ci(u['paired_difference']['cluster_bootstrap95'])} | "
                 f"{rt(b['baseline'])} | {rt(b['defended'])} | {pp(b['paired_difference']['point'])} | {ci(b['paired_difference']['cluster_bootstrap95'])} |")
    L += ['', '## Component comparisons (with minus without)', '', '| Component | With | Without | Unsafe difference | 95% interval | Utility difference | 95% interval | Reading |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |']
    for c in out['comparisons']:
        u, b = c['results']['unsafe_committed_effect'], c['results']['benign_utility_pass']
        L.append(f"| {c['component']} | {c['with']} | {c['without']} | {pp(u['point'])} | {ci(u['cluster_bootstrap95'])} | {pp(b['point'])} | {ci(b['cluster_bootstrap95'])} | "
                 f"{c['security_reading']}; {c['utility_reading']} |")
    L += ['', 'Between-arm differences compare the defended arms of two separate runs on the same units and seeds; each run also has its own baseline, so baseline drift '
          'between runs is visible in the arms table.', '', '## Claims inventory', '', '| Claim | Source | Status | Verdict or reason |', '| --- | --- | --- | --- |']
    for cl in out['claims']:
        L.append(f"| {cl['claim']} | {cl['source']} | {cl['status']} | {cl['verdict']} |")
    L += ['', 'A null or negative component result is reported as it is; no claim in the documentation may rest on a component this table does not credit, unless it is labelled untested.', '']
    (ROOT / AB['outputs']['doc']).write_text('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
