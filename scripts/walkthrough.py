#!/usr/bin/env python3
"""TB-049: pick the walkthrough's examples from recorded evidence, never staged.

  walkthrough.py select   choose, by fixed rules, a benign run, a blocked attack and a failed run of the frozen system from
                          the published run store (web/public/data), and record what each shows
  walkthrough.py cli      run each live-site mode once from the CLI against the public demo (instant; live with the
                          project key; live with your own key, read from NVIDIA_API_KEY) and download a report; records the
                          commands and their real output (no key is ever printed or stored)
  walkthrough.py gate     run the Tier 1 release gate on an unmodified candidate and on one with an injected regression
                          (the TB-038 injection list), in temporary worktrees, and record both outcomes

Both write evidence/tb049-walkthrough.json (merged). docs/architecture.md reads every number from it."""
import json, runpy, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence/tb049-walkthrough.json'
DATA = ROOT / 'web/public/data'
SITE = json.loads((ROOT / 'configs/deploy/public-demo.json').read_text())['public_url']
FROZEN = json.loads((ROOT / 'configs/frozen/selection.json').read_text())['selected']
RENDERING = 'agentdojo_important_instructions'


def load_out() -> dict:
    return json.loads(OUT.read_text()) if OUT.exists() else {'task_id': 'TB-049'}


def save(part: dict):
    out = load_out() | part
    OUT.write_text(json.dumps(out, indent=1) + '\n')


def describe(row: dict, rec: dict, fields: list) -> dict:
    run, case = rec['run'], rec['case']
    return {'run_id': row['run_id'], 'site_path': '/runs/' + quote(row['run_id'], safe=''), 'url': SITE + '/runs/' + quote(row['run_id'], safe=''),
            'report': json.loads((DATA / 'store.json').read_text())['reports'][row['report']]['path'], 'pointer': row['pointer'],
            'case_id': case['case_id'], 'repetition': case['repetition'], 'kind': case['kind'], 'fixture_id': case['fixture_id'],
            'arm': row['arm'], 'outcome': run['outcome'], 'utility_pass': run['evaluation']['utility_pass'], 'security_pass': run['evaluation']['security_pass'],
            'attacker_goal_achieved': run['evaluation']['attacker_goal_achieved'], 'reason_codes': run['evaluation']['reason_codes'],
            'prohibited_side_effects': run['evaluation']['prohibited_side_effects'],
            'tool_calls': [{'tool': t['tool'], 'status': t['status'], 'error': t['error']} for t in run['tool_trace']],
            'policy_decisions': [{'tool': p['tool'], 'decision': p['decision'], 'reason': p['reason']} for p in run.get('policy_decisions') or []],
            'denied_calls': sum(1 for p in run.get('policy_decisions') or [] if p['decision'] == 'deny'),
            'elapsed_ms': run['elapsed_ms'], 'tokens': run['tokens'], 'final_text': run['final_text'],
            'attribution': {k: row[k] for k in ('first_rule', 'first_step', 'utility_rule', 'utility_step', 'security_rule', 'security_step')},
            'timed': row['timed'],
            'parity': {k: case.get(k) for k in ('run_config_identical', 'settings_identical', 'first_request_identical', 'non_tool_messages_identical',
                                                'same_tool_call_sequence', 'differences_attributable_to_gateway')}}


def select():
    idx = json.loads((DATA / 'runs.json').read_text())
    rows = [dict(zip(idx['fields'], r)) for r in idx['rows']]
    store = json.loads((DATA / 'store.json').read_text())
    main = next(r['n'] for r in store['reports'] if r['path'].endswith(f"-{RENDERING}-plain-{FROZEN['system']}-report.json") and FROZEN['model'].split(':')[1].replace('/', '-') in r['path'])
    mine = sorted((r for r in rows if r['report'] == main), key=lambda r: (r['case_id'], r['repetition'], r['arm']))
    records = json.loads((DATA / f'records/{main}.json').read_text())['runs']
    rec = lambda r: records[r['pointer']]
    pair = lambda r: next(x for x in mine if x['case_id'] == r['case_id'] and x['repetition'] == r['repetition'] and x['arm'] == 'baseline')
    benign = next(r for r in mine if r['arm'] == 'defended' and r['kind'] == 'benign' and r['utility_pass'] and r['outcome'] == 'success')
    blocked = next(r for r in mine if r['arm'] == 'defended' and r['kind'] == 'attack' and r['security_pass']
                   and any(p[1] == 'deny' for p in r['policy']) and pair(r)['attacker_goal'] and not pair(r)['security_pass'])
    failed = next(r for r in mine if r['arm'] == 'defended' and r['kind'] == 'benign' and not r['utility_pass'])
    rules = {'source': 'web/public/data (the published run store, TB-030)', 'report': store['reports'][main]['path'],
             'system': FROZEN['system'], 'model': FROZEN['model'], 'rendering': RENDERING, 'split': 'development (the store holds no holdout run)',
             'benign': 'first defended benign run (by case, repetition) that passed utility and whose loop ended with outcome success',
             'blocked_attack': 'first defended attack run that passed security with at least one denied call, whose paired undefended run reached the attacker goal',
             'failure': 'first defended benign run that failed its task'}
    defended_runs = [r for r in mine if r['arm'] == 'defended']
    save({'selected_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'rules': rules,
          'report_counts': {'defended_runs': len(defended_runs), 'defended_benign_failed': sum(1 for r in defended_runs if r['kind'] == 'benign' and not r['utility_pass']),
                            'defended_benign': sum(1 for r in defended_runs if r['kind'] == 'benign')},
          'benign_run': describe(benign, rec(benign), idx['fields']),
          'blocked_attack': {'defended': describe(blocked, rec(blocked), idx['fields']), 'paired_undefended': describe(pair(blocked), rec(pair(blocked)), idx['fields'])},
          'failure': describe(failed, rec(failed), idx['fields'])})
    print(json.dumps({'benign': benign['run_id'], 'blocked': blocked['run_id'], 'failure': failed['run_id']}, indent=1))


def gate():
    injections = runpy.run_path(str(ROOT / 'tests/release/test_injected_regressions.py'), run_name='inj')['INJECTIONS']
    name, path, original, injected, finding = injections[0]
    results = {}
    with tempfile.TemporaryDirectory(dir=ROOT.parent, prefix='.tb049-gate-') as tmp:
        for label in ('unmodified', 'injected'):
            wt = Path(tmp) / label
            subprocess.run(['git', 'worktree', 'add', '--detach', str(wt), 'HEAD'], cwd=ROOT, check=True, capture_output=True)
            try:
                for shared in ('node_modules', '.venv-tools'):
                    (wt / shared).symlink_to(ROOT / shared)
                if label == 'injected':
                    f = wt / path
                    f.write_text(f.read_text().replace(original, injected, 1))
                out = Path(tmp) / f'{label}.json'
                p = subprocess.run([sys.executable, str(ROOT / 'scripts/release-gate-scripted.py'), '--root', str(wt), '--baseline-ref', 'HEAD', '--out', str(out)],
                                   cwd=ROOT, capture_output=True, text=True, timeout=900)
                rec = json.loads(out.read_text())
                results[label] = {'exit_code': p.returncode, 'outcome': rec['outcome'], 'blocking': rec['blocking'],
                                  'security_regressions': {k: v['security_regressions'] for k, v in rec['arms'].items()},
                                  'baseline_commit': rec['baseline_commit'][:12]}
            finally:
                subprocess.run(['git', 'worktree', 'remove', '--force', str(wt)], cwd=ROOT, capture_output=True)
    save({'release_gate': {'injection': {'name': name, 'file': path, 'removed_line': original.strip(), 'replaced_with': injected.strip(), 'expected_finding': finding},
                           'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), **results}})
    print(json.dumps({k: (v['outcome'], v['blocking']) for k, v in results.items()}, indent=1))


def last_json(text: str):
    """The last complete JSON object in a command's output (`--wait` prints the queued run, then the finished one)."""
    dec, found, i = json.JSONDecoder(), None, 0
    while (i := text.find('{', i)) != -1:
        try:
            found, end = dec.raw_decode(text, i)
            i = end
        except json.JSONDecodeError:
            i += 1
    return found


def cli():
    import os, re
    env = dict(os.environ)
    if not env.get('NVIDIA_API_KEY'):
        for line in (ROOT / '.env').read_text().splitlines():
            if line.startswith('NVIDIA_API_KEY='):
                env['NVIDIA_API_KEY'] = line.split('=', 1)[1].strip().strip('"')
    key = env.get('NVIDIA_API_KEY', '')
    base = ['sh', 'bin/trustbench', 'remote']
    url = ['--url', SITE]
    steps = [('instant (no model, no key)', ['run', *url, '--mode', 'scripted', '--system', 'gateway_capability', '--wait']),
             ('live, project key', ['run', *url, '--mode', 'hosted', '--system', FROZEN['system'], '--wait']),
             ('live, your own key', ['run', *url, '--mode', 'own_key', '--system', FROZEN['system'], '--model', FROZEN['model'], '--key-env', 'NVIDIA_API_KEY', '--wait'])]
    only = sys.argv[2:]  # e.g. `cli instant`: rerun only the matching modes, keep the other recorded ones
    previous = {r['mode']: r for r in load_out().get('cli', {}).get('runs', [])}
    records = []
    for label, args in steps:
        if only and not any(o in label for o in only) and label in previous:
            records.append(previous[label]); continue
        p = subprocess.run(base + args, cwd=ROOT, capture_output=True, text=True, env=env, timeout=3600)
        text = (p.stdout + p.stderr).replace(key, '<redacted>') if key else p.stdout + p.stderr
        assert not key or key not in text
        cmd = 'sh bin/trustbench remote ' + ' '.join(args)
        summary = last_json(text)
        records.append({'mode': label, 'command': cmd, 'exit_code': p.returncode, 'summary': summary, 'output': text.rstrip(),
                        'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds')})
    run_id = next((r['summary'].get('id') for r in records if r['summary'] and r['exit_code'] == 0 and r['summary'].get('status') == 'done'), None)
    if run_id and (not only or 'download the report' not in previous):
        out = Path(tempfile.gettempdir()) / 'tb049-report.json'
        args = ['report', run_id, *url, '--out', str(out)]
        p = subprocess.run(base + args, cwd=ROOT, capture_output=True, text=True, env=env, timeout=600)
        records.append({'mode': 'download the report', 'command': 'sh bin/trustbench remote ' + ' '.join(args).replace(str(out), 'report.json'), 'exit_code': p.returncode,
                        'summary': {'report_cases': len(json.loads(out.read_text()).get('cases', [])) if out.exists() else None}, 'output': (p.stdout + p.stderr).replace(str(out), 'report.json').rstrip(),
                        'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds')})
    elif 'download the report' in previous:
        records.append(previous['download the report'])
    transcript = [x for r in records for x in (f"$ {r['command']}", f"# {r['mode']}, recorded {r.get('recorded_at', '')}", r.get('output', ''), '')]
    (ROOT / 'evidence/tb049-cli-transcript.txt').write_text('\n'.join(transcript) + '\n')
    save({'cli': {'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'site': SITE, 'route': 'tailnet (from the host the public relay route does not answer; see docs/deployment-runbook.md)',
                  'runs': records, 'transcript': 'evidence/tb049-cli-transcript.txt'}})
    print(json.dumps([(r['mode'], r['exit_code']) for r in records]))


if __name__ == '__main__':
    {'select': select, 'gate': gate, 'cli': cli}.get(sys.argv[1] if len(sys.argv) > 1 else '', lambda: sys.exit(__doc__))()
