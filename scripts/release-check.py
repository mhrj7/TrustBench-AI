#!/usr/bin/env python3
"""TB-051: final clean-checkout verification of a release candidate (configs/release-checks.yaml).

  release-check.py run <check-id> [--candidate SHA]   run one check and record it in release/checks.json
  release-check.py decide                             RELEASE only if every required check passed on the candidate;
                                                      otherwise BLOCKED, with each failing or missing check as the reason

Every check names its candidate commit; a check recorded for another commit does not count. Results are what the commands
returned, never edited: a failed check stays failed until it is rerun. Passing smoke checks is not a full replication of
the benchmark, and the decision says what was and was not verified."""
import json, os, re, shutil, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'configs/release-checks.yaml').read_text())
OUT = ROOT / CFG['output']
SITE = json.loads((ROOT / 'configs/deploy/public-demo.json').read_text())['public_url']
PY = str(ROOT / '.venv-tools/bin/python')
now = lambda: datetime.now(timezone.utc).isoformat(timespec='seconds')


def sh(cmd, cwd=ROOT, env=None, timeout=7200):
    t = time.monotonic()
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, shell=isinstance(cmd, str))
    return p.returncode, p.stdout + p.stderr, round(time.monotonic() - t, 1)


def last_json(text: str):
    dec, found, i = json.JSONDecoder(), None, 0
    while (i := text.find('{', i)) != -1:
        try:
            found, i = dec.raw_decode(text, i)
        except json.JSONDecodeError:
            i += 1
    return found


def gh_run(workflow: str, sha: str, inputs: dict | None = None, dispatch=False) -> dict:
    if dispatch:
        args = ['gh', 'workflow', 'run', workflow, '--ref', 'main'] + [x for k, v in (inputs or {}).items() for x in ('-f', f'{k}={v}')]
        subprocess.run(args, cwd=ROOT, check=True, capture_output=True)
        time.sleep(20)
    for _ in range(60):
        runs = json.loads(subprocess.run(['gh', 'run', 'list', '--workflow', workflow, '--limit', '20', '--json', 'databaseId,headSha,event,status,conclusion,createdAt'],
                                         cwd=ROOT, capture_output=True, text=True).stdout)
        mine = [r for r in runs if r['headSha'] == sha and (r['event'] == 'workflow_dispatch') == dispatch]
        if mine:
            run = mine[0]
            subprocess.run(['gh', 'run', 'watch', str(run['databaseId']), '--exit-status'], cwd=ROOT, capture_output=True, timeout=7200)
            view = json.loads(subprocess.run(['gh', 'run', 'view', str(run['databaseId']), '--json', 'conclusion,jobs,url'], cwd=ROOT, capture_output=True, text=True).stdout)
            return {'run_id': run['databaseId'], 'url': view['url'], 'conclusion': view['conclusion'],
                    'jobs': {j['name']: j['conclusion'] for j in view['jobs']}}
        time.sleep(30)
    return {'conclusion': 'not found'}


def check_ci_tier1(sha):
    r = gh_run('release-gate.yml', sha)
    return r['conclusion'] == 'success' and r['jobs'].get('tier1') == 'success', r


def check_tier2_live_gate(sha):
    label = f'release-{sha[:12]}'
    code, out, secs = sh([PY, 'scripts/release-gate.py', 'live', '--label', label], timeout=4 * 3600)
    rec = last_json(out) or {}
    path = ROOT / f'evidence/release-gate-{label}-attempt-1.json'
    detail = json.loads(path.read_text()) if path.exists() else {}
    return code == 0 and detail.get('outcome') == 'PASS', {'label': label, 'exit_code': code, 'seconds': secs, 'outcome': detail.get('outcome'),
                                                            'evidence': str(path.relative_to(ROOT)) if path.exists() else None, 'printed': rec}


def check_fresh_clone_verify(sha):
    base = Path(os.environ.get('TRUSTBENCH_STORAGE_ROOT', ROOT.parent)) / '.tb051-fresh'
    if base.exists():
        shutil.rmtree(base)
    base.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.endswith(('_API_KEY', '_TOKEN'))}
    env.update(TRUSTBENCH_STORAGE_ROOT=str(base), npm_config_cache=str(base / '.cache/npm'), UV_CACHE_DIR=str(base / '.cache/uv'), TRUSTBENCH_NO_DOTENV='1')
    steps = [('clone', f'git clone -q {CFG["repository"]} TrustBench-AI && cd TrustBench-AI && git checkout -q {sha}', base),
             ('install', 'cp .env.example .env && npm ci && npm run setup', base / 'TrustBench-AI'),
             ('fetch pinned AgentDojo data', 'sh bin/trustbench fetch-data', base / 'TrustBench-AI'),
             ('npm run verify', 'npm run verify', base / 'TrustBench-AI')]
    results = []
    for name, cmd, cwd in steps:
        code, out, secs = sh(cmd, cwd=cwd, env=env, timeout=4 * 3600)
        results.append({'step': name, 'exit_code': code, 'seconds': secs, 'tail': out.strip().splitlines()[-4:]})
        if code != 0:
            break
    ok = len(results) == len(steps) and all(r['exit_code'] == 0 for r in results)
    if ok:
        shutil.rmtree(base)  # the clone is 1-2 GB; it is evidence only while it fails
    return ok, {'location': 'fresh clone from GitHub on the release host, no .env keys (TRUSTBENCH_NO_DOTENV), own npm and uv caches', 'steps': results}


def check_offline_reproduction(sha):
    log = ROOT / '.tool-state/release-repro-log.json'
    code, out, secs = sh(['sh', 'repro/run-in-container.sh', sha, str(log)], env=dict(os.environ, TRUSTBENCH_STORAGE_ROOT=str(ROOT.parent)), timeout=3 * 3600)
    rec = json.loads(log.read_text()) if log.exists() else {}
    return code == 0 and rec.get('outcome') == 'REPRODUCED' and rec.get('commit') == sha, {
        'exit_code': code, 'seconds': secs, 'outcome': rec.get('outcome'), 'steps_passed': sum(s['exit_code'] == 0 for s in rec.get('steps', [])),
        'steps': len(rec.get('steps', [])), 'unexpected_changes': rec.get('unexpected_changes'), 'route': rec.get('route')}


def check_readme_fresh(sha):
    code, out, secs = sh([PY, 'scripts/check-readme.py', '--fresh', '--ref', sha], timeout=3 * 3600)
    ev = json.loads((ROOT / 'evidence/tb050-readme-check.json').read_text())
    return code == 0 and ev['ok'] and ev['commit'] == sha, {'exit_code': code, 'seconds': secs, 'problems': ev['problems'], 'environment': ev['environment']}


def check_demo_rebuilt(sha):
    tag = f'trustbench-live:{sha[:7]}'
    code, out, secs = sh(f'git archive {sha} | docker build -q -f Dockerfile.service -t {tag} -', timeout=3600)
    if code != 0:
        return False, {'build_exit_code': code, 'tail': out.strip().splitlines()[-3:]}
    sh(['docker', 'tag', tag, 'trustbench-live:demo'])
    code2, out2, _ = sh('docker compose -f deploy/compose.yaml up -d --no-build', env=dict(os.environ, TRUSTBENCH_DEMO_PORT='8088'))
    health = ''
    for _ in range(60):
        health = subprocess.run(['docker', 'inspect', '-f', '{{.State.Health.Status}}', 'trustbench-demo-live-1'], capture_output=True, text=True).stdout.strip()
        if health == 'healthy':
            break
        time.sleep(2)
    image = subprocess.run(['docker', 'inspect', '-f', '{{.Image}}', 'trustbench-demo-live-1'], capture_output=True, text=True).stdout.strip()
    built = subprocess.run(['docker', 'image', 'inspect', '-f', '{{.Id}}', tag], capture_output=True, text=True).stdout.strip()
    return code2 == 0 and health == 'healthy' and image == built, {'image_tag': tag, 'image_id': built[:19], 'running_image': image[:19], 'health': health,
                                                                     'build_seconds': secs, 'source': f'git archive {sha[:12]} (committed files only)'}


def check_live_site_external(sha):
    r = gh_run('public-demo-check.yml', sha, {'live': 'true'}, dispatch=True)
    return r['conclusion'] == 'success' and r['jobs'].get('full') == 'success', {**r, 'vantage': 'GitHub Actions ubuntu-24.04 runners (outside the host)',
                                                                               'covers': 'health, pages, catalog, security refusals, instant run (API and CLI), report schema, run isolation, '
                                                                                         'live runs with the project key (API and CLI), a rejected own key giving an explicit invalid run, '
                                                                                         'the per-visitor rate limit, and in Chrome: instant and live runs from the Live page with the report '
                                                                                         'download, and the own-key form'}


def check_own_key_real(sha):
    env = dict(os.environ)
    if not env.get('NVIDIA_API_KEY'):
        for line in (ROOT / '.env').read_text().splitlines():
            if line.startswith('NVIDIA_API_KEY='):
                env['NVIDIA_API_KEY'] = line.split('=', 1)[1].strip().strip('"')
    key = env.get('NVIDIA_API_KEY', '')
    code, out, secs = sh(['sh', 'bin/trustbench', 'remote', 'run', '--url', SITE, '--mode', 'own_key', '--system', 'gateway_directive_flow_v4',
                          '--model', 'nvidia:openai/gpt-oss-20b', '--key-env', 'NVIDIA_API_KEY', '--cases', 'doc-benign,doc-attack', '--wait'], env=env, timeout=3600)
    leaked = bool(key) and key in out
    s = last_json(out.replace(key, '<redacted>') if key else out) or {}
    summ = s.get('summary') or {}
    return code == 0 and not leaked and s.get('status') == 'done' and summ.get('valid_pairs', 0) > 0, {
        'vantage': 'the release host over the tailnet route (the host cannot reach its own public relay address)', 'status': s.get('status'),
        'valid_pairs': summ.get('valid_pairs'), 'unsafe_committed_effect': summ.get('unsafe_committed_effect'), 'key_in_output': leaked, 'seconds': secs}


def check_no_key_paths(sha):
    """Paths that need no key: instant runs, and a spent shared budget (staging with a tiny daily budget)."""
    env = dict(os.environ, TRUSTBENCH_DEMO_PORT='18088', TRUSTBENCH_DEPLOY_PROFILE='configs/deploy/staging-tiny-budget.json', TRUSTBENCH_IMAGE=f'trustbench-live:{sha[:7]}')
    up, out, _ = sh('docker compose -p trustbench-staging-tb051 -f deploy/compose.yaml up -d --no-build', env=env)
    try:
        for _ in range(60):
            if subprocess.run(['docker', 'inspect', '-f', '{{.State.Health.Status}}', 'trustbench-staging-tb051-live-1'], capture_output=True, text=True).stdout.strip() == 'healthy':
                break
            time.sleep(2)
        code, out, secs = sh([PY, 'scripts/check-deployment.py', '--url', 'http://127.0.0.1:18088', '--live', '--exhaust', '--out', str(ROOT / '.tool-state/release-staging-check.json')], timeout=3600)
        rec = json.loads((ROOT / '.tool-state/release-staging-check.json').read_text())
        names = {c['check']: c['passed'] for c in rec['checks']}
        wanted = [n for n in names if n.startswith(('instant run', 'exhausted shared budget'))]
        return up == 0 and all(names[n] for n in wanted) and len(wanted) >= 4, {'stack': 'staging (own volume, profile staging-tiny-budget), the public demo untouched',
                                                                            'checks': {n: names[n] for n in wanted}, 'all_checks': f"{sum(names.values())}/{len(names)} passed"}
    finally:
        sh('docker compose -p trustbench-staging-tb051 -f deploy/compose.yaml down -v', env=env)


def check_linked_reports(sha):
    files = [f for f in subprocess.run(['git', 'ls-files', '*.md'], cwd=ROOT, capture_output=True, text=True).stdout.split()
             if f.startswith(('README.md', 'docs/', 'research/', 'repro/', 'protocol/'))]
    broken, external = [], set()
    for f in files:
        text = (ROOT / f).read_text()
        for auto in re.findall(r'<(https?://[^>\s]+)>', text):  # autolinks
            external.add(auto.split('#')[0])
        for target in re.findall(r'\]\(([^)\s]+)\)', text):
            if target.startswith('http'):
                external.add(target.split('#')[0]); continue
            if target.startswith(('#', 'mailto:')) or '{{' in target:
                continue
            p = ((ROOT / f).parent / target.split('#')[0]).resolve()
            if not p.exists():
                broken.append(f'{f}: {target}')
    readme_external = sorted(u for u in external if u in (ROOT / 'README.md').read_text())
    unreachable = []
    for u in readme_external:
        code, out, _ = sh(['curl', '-s', '-o', '/dev/null', '-L', '-m', '20', '-w', '%{http_code}', u], timeout=60)
        if not out.strip().isdigit() or int(out.strip()) >= 400:
            if 'trustbench.taila273c6.ts.net' not in u:  # checked from outside by live_site_external; the host cannot reach its own relay
                unreachable.append(f'{u}: {out.strip()}')
    gates = {}
    for name, cmd in (('report and claims ledgers', [PY, 'scripts/build-report.py', '--check']), ('claim boundaries', [PY, 'scripts/check-claims.py']),
                      ('README instructions', [PY, 'scripts/check-readme.py']), ('reproducibility package', [PY, 'scripts/repro.py', 'check']),
                      ('published reports reproduce', ['sh', 'bin/trustbench', 'report', '--check'])):
        gates[name] = sh(cmd, timeout=1800)[0] == 0
    return not broken and not unreachable and all(gates.values()), {'markdown_files': len(files), 'broken_links': broken, 'readme_external_links': len(readme_external),
                                                                     'unreachable': unreachable, 'report_checks': gates}


CHECKS = {'ci_tier1': check_ci_tier1, 'tier2_live_gate': check_tier2_live_gate, 'fresh_clone_verify': check_fresh_clone_verify,
          'offline_reproduction': check_offline_reproduction, 'readme_fresh': check_readme_fresh, 'demo_rebuilt': check_demo_rebuilt,
          'live_site_external': check_live_site_external, 'own_key_real': check_own_key_real, 'no_key_paths': check_no_key_paths,
          'linked_reports': check_linked_reports}


def load() -> dict:
    return json.loads(OUT.read_text()) if OUT.exists() else {'task_id': 'TB-051', 'checks': {}}


def run(check_id: str, sha: str):
    spec = next(c for c in CFG['checks'] if c['id'] == check_id)
    started = now()
    try:
        ok, detail = CHECKS[check_id](sha)
    except Exception as e:  # recorded as a failure, never hidden
        ok, detail = False, {'error': f'{type(e).__name__}: {e}'}
    import fcntl
    with open(OUT.parent / '.checks.lock', 'w') as lock:  # checks run in parallel; each records under the lock
        fcntl.flock(lock, fcntl.LOCK_EX)
        record(check_id, spec, sha, ok, detail, started)
    print(json.dumps({'check': check_id, 'ok': bool(ok)}))
    return ok


def record(check_id, spec, sha, ok, detail, started):
    rec = load()
    rec['checks'][check_id] = {'name': spec['name'], 'required': spec['required'], 'candidate': sha, 'ok': bool(ok), 'started_at': started,
                               'finished_at': now(), 'detail': detail}
    OUT.write_text(json.dumps(rec, indent=1) + '\n')


def decide():
    rec = load()
    sha = rec.get('candidate')
    reasons = []
    for spec in CFG['checks']:
        c = rec['checks'].get(spec['id'])
        if not c:
            reasons.append(f"{spec['id']}: not run") if spec['required'] else None
        elif c['candidate'] != sha:
            reasons.append(f"{spec['id']}: recorded for {c['candidate'][:12]}, not the candidate") if spec['required'] else None
        elif spec['required'] and not c['ok']:
            reasons.append(f"{spec['id']}: failed ({spec['name']})")
    later = subprocess.run(['git', 'diff', '--name-only', f'{sha}..HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.split()
    code_changed = [f for f in later if not f.startswith(tuple(CFG['evidence_only_paths']))]
    if code_changed:
        reasons.append(f'files other than evidence changed after the candidate: {code_changed[:10]}')
    rec['decision'] = {'outcome': 'RELEASE' if not reasons else 'BLOCKED', 'reasons': reasons, 'decided_at': now(),
                       'changed_after_candidate': later, 'scope': CFG['scope_note']}
    OUT.write_text(json.dumps(rec, indent=1) + '\n')
    print(json.dumps(rec['decision'], indent=1))
    return not reasons


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['run']:
        sha = a[a.index('--candidate') + 1] if '--candidate' in a else load().get('candidate')
        if not sha:
            sys.exit('give --candidate SHA the first time')
        sha = subprocess.run(['git', 'rev-parse', sha], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        rec = load()
        if rec.get('candidate') not in (None, sha):
            sys.exit(f"release/checks.json is for candidate {rec['candidate'][:12]}; start a new file for a new candidate")
        rec['candidate'] = sha
        OUT.parent.mkdir(exist_ok=True)
        (OUT.parent / '.gitignore').write_text('.checks.lock\n')
        OUT.write_text(json.dumps(rec, indent=1) + '\n')
        sys.exit(0 if run(a[1], sha) else 1)
    if a[:1] == ['decide']:
        sys.exit(0 if decide() else 1)
    sys.exit(__doc__)
