#!/usr/bin/env python3
"""Tier 1 of the release gate (A-028, TB-038): credential-free and deterministic, for every change.

For each system in configs/release-gate.yaml scripted.arm_baselines, runs the scripted development suite fresh (in a
temporary output directory, never over the committed files) and compares it, case by case and repetition by repetition,
with the baseline report as committed on the baseline ref (default HEAD; CI sets the default branch, so a change cannot
move its own baseline). Also reruns the scripted smoke suite and compares it with its committed result.

  release-gate-scripted.py [--root CANDIDATE_CHECKOUT] [--baseline-ref REF] [--out FILE]

Outcome: FAIL on any runner or parity failure, a changed case set, a defended-arm security or functional regression, any
baseline-arm verdict change (the harness or evaluator changed), or a smoke-suite difference; PASS otherwise. Defended-arm
improvements pass and are listed for a deliberate baseline refresh. Exit 0 only on PASS."""
import argparse, json, os, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

GATE_ROOT = Path(__file__).resolve().parents[1]  # the trusted checkout: baselines come from its git history
CFG = json.loads((GATE_ROOT / 'configs/release-gate.yaml').read_text())['scripted']


def committed(path: str, ref: str):
    out = subprocess.run(['git', 'show', f'{ref}:{path}'], cwd=GATE_ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f'baseline {path} not found at {ref}')
    return json.loads(out.stdout)


def normalise(value, volatile):
    if isinstance(value, dict):
        return {k: normalise(v, volatile) for k, v in sorted(value.items()) if k not in volatile}
    if isinstance(value, list):
        return [normalise(v, volatile) for v in value]
    return value


def compare_arm(base: dict, fresh: dict) -> dict:
    v = CFG['verdicts']
    key = lambda c: (c['case_id'], c['repetition'])
    b, f = {key(c): c for c in base['cases']}, {key(c): c for c in fresh['cases']}
    findings = {'missing_cases': sorted(f'{k[0]}#r{k[1]}' for k in set(b) - set(f)), 'new_cases': sorted(f'{k[0]}#r{k[1]}' for k in set(f) - set(b)),
                'security_regressions': [], 'functional_regressions': [], 'baseline_arm_changes': [], 'parity_failures': [], 'improvements': []}
    for k in sorted(set(b) & set(f)):
        unit = f'{k[0]}#r{k[1]}'
        for arm in ('baseline', 'defended'):
            be, fe = b[k][arm]['evaluation'] | {'invalid': b[k][arm]['invalid']}, f[k][arm]['evaluation'] | {'invalid': f[k][arm]['invalid']}
            for flag in v['no_loss'] + v['no_gain']:
                if be[flag] == fe[flag]:
                    continue
                worse = (be[flag] and not fe[flag]) if flag in v['no_loss'] else (fe[flag] and not be[flag])
                item = f'{unit} {arm}.{flag}: {be[flag]} -> {fe[flag]}'
                if arm == 'baseline':
                    findings['baseline_arm_changes'].append(item)
                elif not worse:
                    findings['improvements'].append(item)
                elif flag in ('security_pass', 'attacker_goal_achieved'):
                    findings['security_regressions'].append(item)
                else:
                    findings['functional_regressions'].append(item)
        for check in CFG['parity_checks']:
            if b[k].get(check) is True and f[k].get(check) is not True:
                findings['parity_failures'].append(f'{unit} {check}')
    return findings


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', type=Path, default=GATE_ROOT, help='candidate checkout to run (default: this one)')
    ap.add_argument('--baseline-ref', default=os.environ.get(CFG['baseline_ref_env']) or CFG['default_baseline_ref'])
    ap.add_argument('--out', type=Path, default=None, help=f"record path (default {CFG['output']} in the candidate)")
    a = ap.parse_args()
    root = a.root.resolve()
    record = {'gate': 'tier1-scripted', 'rule': 'protocol/amendments.md A-028', 'checked_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
              'candidate_root': str(root), 'baseline_ref': a.baseline_ref,
              'baseline_commit': subprocess.run(['git', 'rev-parse', a.baseline_ref], cwd=GATE_ROOT, capture_output=True, text=True).stdout.strip(), 'arms': {}, 'smoke_suite': None}
    blocking = []
    with tempfile.TemporaryDirectory(prefix='tb-gate-') as tmp:
        for spec in CFG['arm_baselines']:
            out = Path(tmp) / spec['system']
            p = subprocess.run(['node', '--experimental-strip-types', '--no-warnings', 'scripts/run-arm-smoke.mjs', '--defended-system', spec['system'],
                                '--out-dir', str(out), '--work-dir', str(out / 'work')], cwd=root, capture_output=True, text=True)
            arm = {'system': spec['system'], 'baseline': spec['report'], 'runner_exit_code': p.returncode}
            if not (out / 'report.json').exists():
                arm['error'] = (p.stderr.strip().splitlines() or ['no report'])[-1][:300]
                blocking.append(f"{spec['system']}: runner produced no report")
            else:
                findings = compare_arm(committed(spec['report'], a.baseline_ref), json.loads((out / 'report.json').read_text()))
                arm.update(findings)
                for kind in ('missing_cases', 'new_cases', 'security_regressions', 'functional_regressions', 'baseline_arm_changes', 'parity_failures'):
                    if findings[kind]:
                        blocking.append(f"{spec['system']}: {len(findings[kind])} {kind.replace('_', ' ')}")
            record['arms'][spec['system']] = arm
        smoke = CFG['smoke_suite']
        p = subprocess.run(smoke['command'], cwd=root, capture_output=True, text=True)
        fresh_path = root / smoke['output']
        same = p.returncode == 0 and fresh_path.exists() and normalise(json.loads(fresh_path.read_text()), set(smoke['volatile_keys'])) == normalise(committed(smoke['output'], a.baseline_ref), set(smoke['volatile_keys']))
        record['smoke_suite'] = {'exit_code': p.returncode, 'matches_baseline': same}
        if not same:
            blocking.append('smoke suite differs from its baseline')
    record['blocking'] = blocking
    record['outcome'] = 'FAIL' if blocking else 'PASS'
    record['improvements_needing_baseline_refresh'] = sum(len(x.get('improvements', [])) for x in record['arms'].values())
    out = a.out or root / CFG['output']
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=1) + '\n')
    print(json.dumps({'outcome': record['outcome'], 'blocking': blocking, 'improvements': record['improvements_needing_baseline_refresh']}))
    sys.exit(0 if record['outcome'] == 'PASS' else 1)


if __name__ == '__main__':
    main()
