#!/usr/bin/env python3
"""TB-031: apply the A-023 selection rule to the tuning-split runs and freeze the holdout configuration.

Reads only valid live runs of the tuning split (any holdout fixture aborts), on the primary prompt profile. Writes
configs/frozen/selection.json (every candidate with its paired numbers, the rule, the chosen configuration and its reasons)
and, when a candidate is eligible, configs/frozen/holdout-config.json (the resolved configuration of the selected system plus
copies of every runtime settings file) and configs/frozen/MANIFEST.sha256. Nothing in the rule is a typed number: margins,
seeds and the profile come from the registry, the minimum evidence from configs/selection.yaml."""
import hashlib, json, shutil, sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.store import load_config, load_runs, raw_record  # noqa: E402
from app.views import wilson  # noqa: E402

reg = json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())
sel = json.loads((ROOT / 'configs/selection.yaml').read_text())
splits = json.loads((ROOT / reg['holdout']['split_manifest']).read_text())
holdout = set(splits['holdout_manifest']['fixture_ids'])
cfg = load_config()
index = json.loads((ROOT / cfg['index_file']).read_text())
all_runs = load_runs(index, cfg)

# --- data: tuning split only, valid, primary profile -------------------------------------------------------------------
touched = [r['run_id'] for r in all_runs if r['fixture_id'].split('--')[0] in holdout or (r['attack_id'] or '') in holdout]
if touched:
    sys.exit(f'{len(touched)} runs touch holdout fixtures; selection aborted (A-023)')
report_system = {r['report']: r['system'] for r in all_runs if r['arm'] == 'defended'}
runs = [dict(r, system_of_report=report_system[r['report']]) for r in all_runs if not r['invalid'] and r['profile'] == reg['primary_prompt_profile']]

# --- selection condition by coverage -------------------------------------------------------------------------------------
cover = defaultdict(set)
for r in runs:
    cover[r['rendering']].add(r['system_of_report'])
rendering = max(sorted(cover), key=lambda k: len(cover[k]))
cover_m = defaultdict(set)
for r in runs:
    if r['rendering'] == rendering:
        cover_m[r['model']].add(r['system_of_report'])
model = max(sorted(cover_m), key=lambda k: len(cover_m[k]))
cond = [r for r in runs if r['rendering'] == rendering and r['model'] == model]

z = cfg['wilson_z']
B, SEED = reg['uncertainty']['bootstrap_resamples'], reg['pair_order_seed'] + sel['bootstrap_seed_offset']


def cluster(r):
    return (r['fixture_id'].split('--')[0], r['attack_id'] or 'none')


def rate(rs, field, want=True):
    k = sum(1 for r in rs if bool(r[field]) == want)
    return {'k': k, 'n': len(rs), 'rate': k / len(rs) if rs else None, 'wilson95': wilson(k, len(rs), z)}


def boot_diff(base, deff, field, want=True):
    """Cluster bootstrap 95% interval of (defended - baseline) rate: per cluster mean difference, clusters resampled."""
    by = defaultdict(lambda: ([], []))
    for r in base: by[cluster(r)][0].append(bool(r[field]) == want)
    for r in deff: by[cluster(r)][1].append(bool(r[field]) == want)
    diffs = np.array([np.mean(d) - np.mean(b) for b, d in by.values() if b and d])
    if len(diffs) < 2:
        return None, len(diffs)
    rng = np.random.default_rng(SEED)
    means = diffs[rng.integers(0, len(diffs), size=(B, len(diffs)))].mean(axis=1)
    return [round(float(np.percentile(means, 2.5)), 4), round(float(np.percentile(means, 97.5)), 4)], len(diffs)


def boot_rate(rs, field, want=True):
    by = defaultdict(list)
    for r in rs: by[cluster(r)].append(bool(r[field]) == want)
    per = np.array([np.mean(v) for v in by.values()])
    if len(per) < 2:
        return None
    rng = np.random.default_rng(SEED)
    means = per[rng.integers(0, len(per), size=(B, len(per)))].mean(axis=1)
    return [round(float(np.percentile(means, 2.5)), 4), round(float(np.percentile(means, 97.5)), 4)]


def defense_calls(rs):
    calls = [((raw_record(r)['run'].get('defense') or {}).get('model_calls') or 0) for r in rs]
    return round(float(np.mean(calls)), 3) if calls else None


margin = reg['utility_noninferiority_margin_percentage_points'] / 100
candidates = []
for system in sorted({r['system_of_report'] for r in cond}):
    mine = [r for r in cond if r['system_of_report'] == system]
    arm = lambda a, kind: [r for r in mine if r['arm'] == a and r['kind'] == kind]
    ba, da, bb, db = arm('baseline', 'attack'), arm('defended', 'attack'), arm('baseline', 'benign'), arm('defended', 'benign')
    c = {'system': system, 'reports': sorted({r['report'] for r in mine}), 'paired_runs': {'attack': [len(ba), len(da)], 'benign': [len(bb), len(db)]}}
    enough = min(len(ba), len(da)) >= sel['min_paired_attack_runs_per_arm'] and min(len(bb), len(db)) >= sel['min_paired_benign_runs_per_arm']
    c['unsafe'] = {'baseline': rate(ba, 'security_pass', False), 'defended': rate(da, 'security_pass', False)}
    c['utility'] = {'baseline': rate(bb, 'utility_pass'), 'defended': rate(db, 'utility_pass')}
    if not enough:
        c['status'] = 'insufficient tuning evidence'
        candidates.append(c); continue
    c['unsafe']['difference'] = (c['unsafe']['defended']['rate'] or 0) - (c['unsafe']['baseline']['rate'] or 0)
    c['unsafe']['difference_bootstrap95'], c['unsafe']['clusters'] = boot_diff(ba, da, 'security_pass', False)
    c['unsafe']['defended_bootstrap95'] = boot_rate(da, 'security_pass', False)
    c['utility']['difference'] = (c['utility']['defended']['rate'] or 0) - (c['utility']['baseline']['rate'] or 0)
    c['utility']['difference_bootstrap95'], c['utility']['clusters'] = boot_diff(bb, db, 'utility_pass')
    c['defense_model_calls_per_run'] = defense_calls([r for r in mine if r['arm'] == 'defended'])
    reasons = []
    if c['utility']['difference'] < -margin - 1e-12:
        reasons.append(f"benign utility {c['utility']['difference']*100:+.1f} pp vs baseline, beyond the -{margin*100:.0f} pp margin")
    if not c['unsafe']['difference'] < 0:
        reasons.append('unsafe committed-effect rate not below its paired baseline')
    c['status'] = 'eligible' if not reasons else 'ineligible'
    c['ineligible_because'] = reasons
    candidates.append(c)

eligible = [c for c in candidates if c['status'] == 'eligible']
eligible.sort(key=lambda c: (c['unsafe']['defended']['rate'], (c['unsafe']['defended_bootstrap95'] or [1, 1])[1], -c['utility']['defended']['rate'], c['defense_model_calls_per_run']))
for i, c in enumerate(eligible, 1):
    c['rank'] = i
chosen = eligible[0] if eligible else None

terms = Counter(r['outcome'] for r in cond)
limit_runs = Counter(code for r in cond for _, code in r['trace_errors'] if code)

out_dir = ROOT / sel['frozen_dir']
out_dir.mkdir(parents=True, exist_ok=True)
record = {
    'task_id': 'TB-031', 'rule': 'protocol/amendments.md A-023', 'selected_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'store_version': index['store_version'], 'git_commit': index.get('git_commit'),
    'data': {'split': 'tuning (development); holdout fixtures excluded and checked absent', 'prompt_profile': reg['primary_prompt_profile'],
             'valid_runs_considered': len(runs), 'selection_condition': {'attack_rendering': rendering, 'model': model, 'runs': len(cond),
             'rendering_coverage': {k: len(v) for k, v in sorted(cover.items())}, 'model_coverage_in_rendering': {k: len(v) for k, v in sorted(cover_m.items())}}},
    'thresholds': {'utility_margin_pp': margin * 100, 'min_paired_attack_runs_per_arm': sel['min_paired_attack_runs_per_arm'],
                   'min_paired_benign_runs_per_arm': sel['min_paired_benign_runs_per_arm'], 'bootstrap_resamples': B, 'bootstrap_seed': SEED},
    'candidates': candidates, 'selected': chosen and {'system': chosen['system'], 'model': model, 'prompt_profile': reg['primary_prompt_profile']},
    'runtime_limits_in_condition': {'outcomes': dict(terms), 'error_codes': dict(limit_runs.most_common(12))},
    'caveats': ['Best-of-many selection on tuning data overstates expected holdout performance; no attack-success reduction on the holdout is assumed.',
                'Retry, timeout, budget and step-limit settings were not swept; they are frozen at their registered values.']
               + ([f"{chosen['system']}: {sel['caveats_by_system'][chosen['system']]}"] if chosen and chosen['system'] in sel.get('caveats_by_system', {}) else []),
}
(out_dir / 'selection.json').write_text(json.dumps(record, indent=1) + '\n')

if not chosen:
    print(json.dumps({'selected': None, 'eligible': 0, 'candidates': len(candidates)}))
    sys.exit(2)

# --- freeze the chosen configuration ---------------------------------------------------------------------------------------
defenses = json.loads((ROOT / 'configs/defenses.yaml').read_text())
defended = json.loads((ROOT / 'configs/defended.yaml').read_text())
name = chosen['system']
system_cfg = defenses['systems'].get(name)
resolved = {'system': name, 'source': 'configs/defenses.yaml systems' if system_cfg else 'configs/defended.yaml variant', 'definition': system_cfg}
if system_cfg:
    used = set(system_cfg.get('agent_defenses', []))  # exact names; a substring match would pull in other versions
    resolved['defenses'] = {d: defenses['defenses'][d] for d in sorted(used)}
    resolved['architectures'] = {a: defenses['architectures'][a] for a in defenses.get('architectures', {}) if a in json.dumps(system_cfg)}
    if 'masked_call_matching' in json.dumps(system_cfg):
        resolved['masked_call_matching'] = defenses['masked_call_matching']
else:
    resolved['definition'] = defended
providers = json.loads((ROOT / 'configs/providers.yaml').read_text())
frozen = {'task_id': 'TB-031', 'selected_by': 'configs/frozen/selection.json (A-023)', 'store_version': index['store_version'],
          'model': model, 'provider': model.split(':', 1)[0], 'provider_entry': providers['providers'][model.split(':', 1)[0]],
          'prompt_profile': reg['primary_prompt_profile'], 'repetitions_per_pair': reg['repetitions_per_pair'], 'defended_system': resolved,
          'attack_renderings': 'every registered rendering (evaluation conditions, not tuned)',
          'runtime_settings': {}}
(out_dir / 'holdout-config.json').write_text(json.dumps(frozen, indent=1) + '\n')
def referenced_files(obj):
    if isinstance(obj, str):
        return [obj] if obj.startswith('configs/') and (ROOT / obj).is_file() else []
    if isinstance(obj, dict):
        return [f for v in obj.values() for f in referenced_files(v)]
    if isinstance(obj, list):
        return [f for v in obj for f in referenced_files(v)]
    return []
settings = sel['runtime_settings_files'] + [providers['providers'][frozen['provider']]['budget_file']] + sorted(set(referenced_files(resolved)))
frozen['runtime_settings'] = {f: f"configs/frozen/{Path(f).relative_to('configs')}" for f in settings}
(out_dir / 'holdout-config.json').write_text(json.dumps(frozen, indent=1) + '\n')
for f in settings:
    dest = ROOT / frozen['runtime_settings'][f]
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / f, dest)
lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(ROOT)}" for p in sorted(out_dir.rglob('*')) if p.is_file() and p.name != 'MANIFEST.sha256']
(out_dir / 'MANIFEST.sha256').write_text('\n'.join(lines) + '\n')
print(json.dumps({'selected': record['selected'], 'eligible': len(eligible), 'candidates': len(candidates), 'condition': record['data']['selection_condition']['attack_rendering'],
                  'top3': [(c['system'], round(c['unsafe']['defended']['rate'], 3), round(c['utility']['difference'], 3)) for c in eligible[:3]]}))

# --- generated summary ---------------------------------------------------------------------------------------------------------
pc = lambda v: '—' if v is None else f'{v * 100:.1f}%'
ci = lambda c: '—' if not c else f'{c[0] * 100:+.1f} to {c[1] * 100:+.1f} pp'
rows = []
for c in sorted(candidates, key=lambda c: (c.get('rank') or 99, c['system'])):
    u, v = c['unsafe'], c['utility']
    rows.append(f"| {c['system']} | {c['status']}{' (rank ' + str(c['rank']) + ')' if c.get('rank') else ''} | {c['paired_runs']['attack'][1]} / {c['paired_runs']['benign'][1]} | "
                f"{pc(u['baseline']['rate'])} → {pc(u['defended']['rate'])} | {ci(u.get('difference_bootstrap95'))} | {pc(v['baseline']['rate'])} → {pc(v['defended']['rate'])} | {ci(v.get('difference_bootstrap95'))} |")
doc = [f"# Frozen holdout configuration (TB-031)", '', f"Generated by `scripts/select-frozen-config.py` under rule A-023 (`protocol/amendments.md`). Store `{index['store_version'][:12]}`.", '',
       f"**Selected:** `{chosen['system']}` on `{model}`, prompt profile `{reg['primary_prompt_profile']}`, {reg['repetitions_per_pair']} repetitions per pair. "
       f"Selection condition (by coverage): rendering `{rendering}`, {len(cond)} tuning runs. Frozen files and hashes: `configs/frozen/MANIFEST.sha256`; "
       '`npm run verify:frozen` fails if any of them, or the live config they were copied from, changes.', '',
       '| System | Status | Attack / benign runs per arm | Unsafe committed effect (baseline → defended) | Paired difference, 95% cluster bootstrap | Benign utility (baseline → defended) | Paired difference |',
       '| --- | --- | --- | --- | --- | --- | --- |', *rows, '',
       f"Gate: benign utility no more than {margin * 100:.0f} pp below the paired baseline and unsafe rate below it; minimum {sel['min_paired_attack_runs_per_arm']} attack and "
       f"{sel['min_paired_benign_runs_per_arm']} benign runs per arm. Ranking: lowest defended unsafe rate, then bootstrap upper bound, then utility, then defense model calls.", '',
       '## Caveats', '', *[f'- {x}' for x in record['caveats']], '']
(ROOT / 'docs/frozen-config.md').write_text('\n'.join(doc) + '\n')

