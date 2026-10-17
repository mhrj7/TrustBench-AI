#!/usr/bin/env python3
"""TB-042: rollback and artifact-restore drill. Recovery times are measured on this run, never assumed.

  rollback-drill.py [--release REF] [--only config|data|deploy]

1. Config rollback. A candidate checkout of the previous release receives a bad policy/config change
   (configs/rollback-drill.yaml names it). Tier 1 of the release gate must FAIL it; the configuration is then restored
   from the release (`git checkout REF -- configs`), the representative fixtures (the scripted development suite and the
   smoke suite) are rerun, the gate must PASS, and every policy decision in the rerun's audit trail must equal the
   release's committed trail.
2. Data restore. A staging live-test service accumulates state (an account, guest sessions, runs with reports, policy
   traces and gateway audit logs, a share link); scripts/backup.py backs it up; the directory is then lost; it is restored
   and a fresh service on the restored copy must serve the same runs (byte-identical artifacts), sign the account in, honour
   the share link, and keep every audit file. A damaged backup must be refused.
3. Deployment rollback. A staging container of the current image is replaced by the previous release's image on the same
   data volume; it must come back healthy with the data intact; then it is rolled forward again.
Writes evidence/tb042-rollback-drill.json and reports/rollback-drill.md."""
import argparse, json, os, shutil, subprocess, sys, tempfile, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'configs/rollback-drill.yaml').read_text())
GATE = ROOT / 'scripts/release-gate-scripted.py'
PY = str(ROOT / '.venv-tools/bin/python')


def sh(*args, cwd=ROOT, check=True, env=None, timeout=1800):
    p = subprocess.run(list(map(str, args)), cwd=cwd, capture_output=True, text=True, env={**os.environ, **(env or {})}, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f'{args[:3]} failed: {p.stderr[-600:]}')
    return p


def timed(fn):
    t = time.perf_counter()
    out = fn()
    return out, round(time.perf_counter() - t, 2)


# ---- 1. config rollback ---------------------------------------------------------------------------------------------------
def audit_rows(text: str) -> list[tuple]:
    keys = CFG['config']['audit_fields']
    return sorted(tuple(json.dumps(r.get(k), sort_keys=True) for k in keys) for r in map(json.loads, filter(str.strip, text.splitlines())))


def gate(candidate: Path, release: str, out: Path, keep: Path | None = None) -> dict:
    args = [PY, GATE, '--root', candidate, '--baseline-ref', release, '--out', out] + (['--keep', keep] if keep else [])
    p = sh(*args, check=False)
    return {'exit_code': p.returncode, **json.loads(out.read_text())}


def config_drill(release: str, work: Path) -> dict:
    wt = work / 'candidate'
    sh('git', 'worktree', 'add', '--detach', wt, release)
    try:
        for shared in ('node_modules', '.venv-tools'):
            (wt / shared).symlink_to(ROOT / shared)
        if (ROOT / 'web/node_modules').exists():
            (wt / 'web/node_modules').symlink_to(ROOT / 'web/node_modules')
        bad = CFG['config']['bad_change']
        f = wt / bad['file']
        data = json.loads(f.read_text())
        node = data
        for k in bad['path'][:-1]:
            node = node[k]
        before = node[bad['path'][-1]]
        node[bad['path'][-1]] = bad['value']
        f.write_text(json.dumps(data, indent=2) + '\n')
        ident = {'GIT_AUTHOR_NAME': 'rollback-drill', 'GIT_AUTHOR_EMAIL': 'drill@invalid', 'GIT_COMMITTER_NAME': 'rollback-drill', 'GIT_COMMITTER_EMAIL': 'drill@invalid'}
        sh('git', 'commit', '-qam', f"drill: bad config ({bad['description']})", cwd=wt, env=ident)
        detect, detect_s = timed(lambda: gate(wt, release, work / 'gate-bad.json', work / 'bad-run'))
        def rollback():
            sh('git', 'checkout', release, '--', 'configs', cwd=wt)
            return sh('git', 'diff', '--quiet', release, '--', 'configs', cwd=wt, check=False).returncode == 0
        restored, rollback_s = timed(rollback)
        keep = work / 'rerun'
        verify, verify_s = timed(lambda: gate(wt, release, work / 'gate-rolled-back.json', keep))
        trail = {}
        for spec in json.loads((ROOT / 'configs/release-gate.yaml').read_text())['scripted']['arm_baselines']:
            committed_path = spec['report'].replace('-report.json', '-policy-traces.jsonl')
            committed = sh('git', 'show', f'{release}:{committed_path}').stdout
            fresh = (keep / spec['system'] / 'policy-traces.jsonl').read_text()
            a, b = audit_rows(committed), audit_rows(fresh)
            bad_rows = audit_rows((work / 'bad-run' / spec['system'] / 'policy-traces.jsonl').read_text())
            trail[spec['system']] = {'decisions_release': len(a), 'decisions_after_rollback': len(b), 'identical': a == b,
                                     'decisions_changed_by_bad_change': len(set(bad_rows) ^ set(a))}
        return {'release': release, 'release_commit': sh('git', 'rev-parse', release).stdout.strip()[:12],
                'bad_change': {**bad, 'value_before': before},
                'detect': {'outcome': detect['outcome'], 'blocking': detect['blocking'], 'seconds': detect_s},
                'rollback': {'configs_equal_release': restored, 'seconds': rollback_s},
                'verify': {'outcome': verify['outcome'], 'blocking': verify['blocking'], 'smoke_suite_matches': verify['smoke_suite']['matches_baseline'], 'seconds': verify_s},
                'audit_trail': trail, 'recovery_seconds': round(rollback_s + verify_s, 2),
                'ok': detect['outcome'] == 'FAIL' and restored and verify['outcome'] == 'PASS' and all(t['identical'] for t in trail.values())}
    finally:
        sh('git', 'worktree', 'remove', '--force', wt, check=False)


# ---- 2. data restore --------------------------------------------------------------------------------------------------------
class Svc:
    """A real live-test service process on a data directory (no project key: instant runs only)."""
    def __init__(self, data: Path, port: int):
        self.data, self.port, self.base = data, port, f'http://127.0.0.1:{port}'
        env = {**os.environ, 'TRUSTBENCH_SERVICE_DATA': str(data), 'TRUSTBENCH_NO_DOTENV': '1'}
        self.proc = subprocess.Popen([PY, '-m', 'uvicorn', 'src.service.app:app', '--host', '127.0.0.1', '--port', str(port)], cwd=ROOT, env=env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        t = time.perf_counter()
        while time.perf_counter() - t < 60:
            try:
                if self.call('GET', '/api/health')[0] == 200:
                    self.ready_s = round(time.perf_counter() - t, 2)
                    return
            except OSError:
                pass
            time.sleep(0.2)
        raise RuntimeError('service did not start')

    def call(self, method, path, body=None, token=None, raw=False, headers=None):
        import urllib.request, urllib.error
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={'content-type': 'application/json', **({'authorization': f'Bearer {token}'} if token else {}), **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
                return r.status, (b if raw else json.loads(b or b'{}'))
        except urllib.error.HTTPError as e:
            b = e.read()
            return e.code, (b if raw else json.loads(b or b'{}'))

    def run(self, token, cases):
        code, job = self.call('POST', '/api/runs', {'mode': 'scripted', 'system': 'gateway_capability', 'cases': cases}, token)
        assert code == 202, job
        t = time.time()
        while time.time() - t < 300:
            s = self.call('GET', f"/api/runs/{job['id']}", token=token)[1]
            if s['status'] not in ('queued', 'running'):
                return s
            time.sleep(0.5)
        raise RuntimeError('run did not finish')

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=20)


def tree_hashes(d: Path) -> dict:
    import hashlib
    return {str(p.relative_to(d)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.rglob('*'))
            if p.is_file() and not p.name.endswith(('.sqlite', '-wal', '-shm', '-journal', '.salt'))}


def snapshot(svc: Svc, guest: str, account: str, runs: list[str], share: tuple[str, str]) -> dict:
    import hashlib
    art = {}
    for rid in runs:
        tok = account if rid == runs[-1] else guest
        for a in ('report', 'evaluation', 'spans'):
            code, body = svc.call('GET', f'/api/runs/{rid}/{a}', token=tok, raw=True)
            art[f'{rid}/{a}'] = (code, hashlib.sha256(body).hexdigest())
    return {'guest_runs': sorted(j['id'] for j in svc.call('GET', '/api/runs', token=guest)[1]),
            'account_runs': sorted(j['id'] for j in svc.call('GET', '/api/runs', token=account)[1]),
            'shared_run': svc.call('GET', f'/api/runs/{share[0]}', headers={'x-trustbench-share': share[1]})[0],
            'artifacts': art}


def data_drill(work: Path) -> dict:
    import re, secrets as pysecrets
    cfg = CFG['data']
    data, backup_dir = work / 'service-data', work / 'backup'
    svc = Svc(data, cfg['port'])
    try:
        guest = svc.call('POST', '/api/session')[1]['token']
        r1, r2 = svc.run(guest, cfg['cases'][:2]), svc.run(guest, cfg['cases'][2:4])
        share = svc.call('POST', f"/api/runs/{r1['id']}/share", token=guest)[1]['share_token']
        email, password = cfg['account_email'], pysecrets.token_urlsafe(18)  # a throwaway account on a throwaway service
        holder = svc.call('POST', '/api/session')[1]['token']
        assert svc.call('POST', '/api/auth/signup', {'email': email, 'password': password}, holder)[0] == 201
        mail = sorted((data / json.loads((ROOT / 'configs/live-service.yaml').read_text())['accounts']['mail']['outbox_dir']).glob('*.json'))[-1]
        token = re.search(r'/account/verify#token=([A-Za-z0-9_-]+)', json.loads(mail.read_text())['body']).group(1)
        account = svc.call('POST', '/api/auth/verify', {'token': token}, holder)[1]['token']
        r3 = svc.run(account, cfg['cases'][:1])
        runs = [r1['id'], r2['id'], r3['id']]
        before = snapshot(svc, guest, account, runs, (r1['id'], share))
        audit_before = tree_hashes(data / 'jobs')
        bk, backup_s = timed(lambda: json.loads(sh(PY, ROOT / 'scripts/backup.py', 'backup', '--source', data, '--dest', backup_dir, '--label', 'tb042 drill (service running)').stdout))
    finally:
        svc.stop()
    lost = work / 'service-data.lost'
    data.rename(lost)  # the data directory is gone (kept aside for the comparison, never deleted)
    damaged = work / 'backup-damaged'
    shutil.copytree(backup_dir, damaged)
    target = next(p for p in sorted((damaged / 'data/jobs').rglob('policy-traces.jsonl')))
    target.write_bytes(target.read_bytes().replace(b'"deny"', b'"allow"', 1) or target.read_bytes() + b' ')
    refused = json.loads(sh(PY, ROOT / 'scripts/backup.py', 'restore', '--backup', damaged, '--dest', work / 'never', check=False).stdout)
    t0 = time.perf_counter()
    restored = json.loads(sh(PY, ROOT / 'scripts/backup.py', 'restore', '--backup', backup_dir, '--dest', data).stdout)
    svc2 = Svc(data, cfg['port'])
    recovery_s = round(time.perf_counter() - t0, 2)
    try:
        after = snapshot(svc2, guest, account, runs, (r1['id'], share))
        login = svc2.call('POST', '/api/auth/login', {'email': email, 'password': password}, svc2.call('POST', '/api/session')[1]['token'])[0]
        audit_after = tree_hashes(data / 'jobs')
        new_run = svc2.run(guest, cfg['cases'][:1])['status']
    finally:
        svc2.stop()
    return {'state': {'runs': len(runs), 'guest_sessions': 1, 'verified_accounts': 1, 'share_links': 1, 'audit_files': len(audit_before)},
            'backup': bk | {'seconds': backup_s, 'taken_while_service_running': True},
            'damaged_backup': {'altered': str(target.relative_to(damaged / 'data')), 'refused': refused.get('refused'), 'problems': refused.get('problems', [])[:3],
                               'nothing_restored': not (work / 'never').exists()},
            'restore': {'ok': restored['ok'], 'files': restored['files'], 'seconds': restored['seconds'], 'service_ready_seconds': svc2.ready_s,
                        'recovery_seconds_restore_to_serving': recovery_s},
            'after_restore': {'same_runs_and_artifacts': before == after, 'account_login_status': login, 'guest_session_still_valid': after['guest_runs'] == before['guest_runs'],
                              'share_link_status': after['shared_run'], 'audit_files_identical': audit_before == audit_after, 'new_run_after_restore': new_run},
            'ok': restored['ok'] and before == after and login == 200 and audit_before == audit_after and refused.get('ok') is False and new_run == 'done'}


def run_store_drill() -> dict:
    p = sh('node', '--test', 'tests/rollback/run-store.test.ts', check=False, timeout=900)
    line = next((l for l in p.stdout.splitlines() if l.startswith('TB042_RUNSTORE ')), None)
    result = json.loads(line.split(' ', 1)[1]) if line else {}
    return {'ok': p.returncode == 0 and bool(line), 'test': 'tests/rollback/run-store.test.ts', **result,
            'note': 'A run killed before a write request leaves that write as outcome-unknown on resume (TB-026: never repeat a '
                    'write whose effect is uncertain); a restored store keeps that behaviour too, because the intent log is restored with it.'}


# ---- 3. deployment rollback ----------------------------------------------------------------------------------------------------
def image_for(ref: str, tag: str) -> str:
    archive = subprocess.Popen(['git', 'archive', '--format=tar', ref], cwd=ROOT, stdout=subprocess.PIPE)
    build = subprocess.run(['docker', 'build', '-q', '-f', 'Dockerfile.service', '-t', tag, '-'], stdin=archive.stdout, capture_output=True, text=True, timeout=1800)
    archive.wait()
    if build.returncode != 0:
        raise RuntimeError(build.stderr[-500:])
    return sh('docker', 'image', 'inspect', '-f', '{{.Id}}', tag).stdout.strip()[:19]


def deploy_drill(release: str) -> dict:
    cfg = CFG['deploy']
    project, port = cfg['compose_project'], cfg['port']
    prev_tag, cur_tag = f"trustbench-live:{release}", f"trustbench-live:{sh('git', 'rev-parse', '--short', 'HEAD').stdout.strip()}"
    images = {'previous': {'ref': release, 'tag': prev_tag, 'id': image_for(release, prev_tag)},
              'current': {'ref': 'HEAD', 'tag': cur_tag, 'id': image_for('HEAD', cur_tag)}}
    def up(tag):
        env = {'TRUSTBENCH_IMAGE': tag, 'TRUSTBENCH_DEMO_PORT': str(port)}
        t = time.perf_counter()
        sh('docker', 'compose', '-p', project, '-f', 'deploy/compose.yaml', 'up', '-d', '--no-build', env=env)
        cid = sh('docker', 'compose', '-p', project, '-f', 'deploy/compose.yaml', 'ps', '-q', 'live', env=env).stdout.strip()
        while time.perf_counter() - t < 180:
            if sh('docker', 'inspect', '-f', '{{.State.Health.Status}}', cid, check=False).stdout.strip() == 'healthy':
                return round(time.perf_counter() - t, 2), sh('docker', 'inspect', '-f', '{{.Config.Image}}', cid).stdout.strip()
            time.sleep(1)
        raise RuntimeError('deployment did not become healthy')
    svc = Svc.__new__(Svc); svc.base = f'http://127.0.0.1:{port}'
    try:
        start_s, running = up(cur_tag)
        token = svc.call('POST', '/api/session')[1]['token']
        job = svc.run(token, CFG['data']['cases'][:2])
        report = lambda: __import__('hashlib').sha256(svc.call('GET', f"/api/runs/{job['id']}/report", token=token, raw=True)[1]).hexdigest()
        before = report()
        quick = lambda: json.loads(sh(PY, ROOT / 'scripts/check-deployment.py', '--url', svc.base, '--quick', check=False).stdout.strip().splitlines()[-1])
        rollback_s, rolled = up(prev_tag)
        after_rollback = {'image': rolled, 'run_still_listed': job['id'] in [j['id'] for j in svc.call('GET', '/api/runs', token=token)[1]],
                          'report_identical': report() == before, 'quick_check': quick(), 'seconds_to_healthy': rollback_s}
        forward_s, forward = up(cur_tag)
        after_forward = {'image': forward, 'report_identical': report() == before, 'quick_check': quick(), 'seconds_to_healthy': forward_s}
    finally:
        sh('docker', 'compose', '-p', project, '-f', 'deploy/compose.yaml', 'down', '-v', check=False, env={'TRUSTBENCH_IMAGE': cur_tag, 'TRUSTBENCH_DEMO_PORT': str(port)})
    ok = (after_rollback['run_still_listed'] and after_rollback['report_identical'] and after_rollback['quick_check'].get('failed') == 0
          and after_forward['report_identical'] and after_forward['quick_check'].get('failed') == 0)
    return {'images': images, 'first_start_seconds': start_s, 'rollback': after_rollback, 'roll_forward': after_forward,
            'recovery_seconds': rollback_s, 'ok': ok, 'note': 'Staging stack with its own volume; the public demo was not touched.'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--release', default=CFG['release'])
    ap.add_argument('--only', choices=['config', 'data', 'deploy'])
    a = ap.parse_args()
    out_path = ROOT / CFG['outputs']['json']
    out = json.loads(out_path.read_text()) if out_path.exists() else {}
    out.update({'task_id': 'TB-042', 'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'commit': sh('git', 'rev-parse', '--short', 'HEAD').stdout.strip()})
    with tempfile.TemporaryDirectory(prefix='tb042-') as tmp:
        work = Path(tmp)
        if a.only in (None, 'config'):
            out['config_rollback'] = config_drill(a.release, work / 'config')
            print(json.dumps({'config_rollback': {k: out['config_rollback'][k] for k in ('ok', 'recovery_seconds')}}), flush=True)
        if a.only in (None, 'data'):
            out['data_restore'] = data_drill(work / 'data')
            out['run_store_restore'] = run_store_drill()
            print(json.dumps({'run_store_restore': out['run_store_restore']['ok']}), flush=True)
            print(json.dumps({'data_restore': {'ok': out['data_restore']['ok'], 'recovery_seconds': out['data_restore']['restore']['recovery_seconds_restore_to_serving']}}), flush=True)
        if a.only in (None, 'deploy'):
            out['deployment_rollback'] = deploy_drill(a.release)
            print(json.dumps({'deployment_rollback': {k: out['deployment_rollback'][k] for k in ('ok', 'recovery_seconds')}}), flush=True)
    out_path.write_text(json.dumps(out, indent=1) + '\n')


if __name__ == '__main__':
    main()
