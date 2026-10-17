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
    original = target.read_bytes()
    # flip one recorded decision (deny -> allow, or allow -> deny): the kind of edit a backup must never let through
    altered = original.replace(b'"deny"', b'"allow"', 1) if b'"deny"' in original else original.replace(b'"allow"', b'"deny"', 1)
    assert altered != original, 'the drill could not alter the audit record'
    target.write_bytes(altered)
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


def write_doc(o: dict):
    c, d, r, k = o['config_rollback'], o['data_restore'], o['run_store_restore'], o['deployment_rollback']
    yes = lambda v: 'yes' if v else '**no**'
    trail = '; '.join(f"{s}: {t['decisions_after_rollback']} of {t['decisions_release']} decisions identical={yes(t['identical'])} ({t['decisions_changed_by_bad_change']} changed by the bad change)"
                      for s, t in c['audit_trail'].items())
    ok = all(x['ok'] for x in (c, d, r, k))
    doc = f"""# Rollback and restore drill (TB-042)

Generated by `scripts/rollback-drill.py` on commit `{o['commit']}`, {o['generated_at']}. Machine-readable copy: `{CFG['outputs']['json']}`.
Previous release: `{c['release']}` (`{c['release_commit']}`). Every time below was measured on this run; none is a target.

Acceptance: *rollback restores expected behavior and audit trail.* Result: **{'met' if ok else 'NOT met'}**.

| Drill | What was restored | Expected behaviour after | Audit trail | Measured recovery |
|---|---|---|---|---|
| Config rollback | `configs/` from `{c['release']}` after a bad policy change | gate {c['verify']['outcome']}, smoke suite matches: {yes(c['verify']['smoke_suite_matches'])} | identical to the release | {c['recovery_seconds']} s (restore {c['rollback']['seconds']} s + rerun {c['verify']['seconds']} s) |
| Service data restore | sessions, accounts, runs, share links ({d['backup']['files']} files, {d['backup']['databases']} databases) | same runs and artifacts: {yes(d['after_restore']['same_runs_and_artifacts'])}; account login {d['after_restore']['account_login_status']}; share link {d['after_restore']['share_link_status']}; new run {d['after_restore']['new_run_after_restore']} | {d['state']['audit_files']} audit files identical: {yes(d['after_restore']['audit_files_identical'])} | {d['restore']['recovery_seconds_restore_to_serving']} s, restore to serving |
| Run-store restore | the durable run store of an interrupted run | resumed, write committed exactly once ({r.get('notes')}), same records as a store that was never lost: {yes(r.get('matches_control'))} | intent log carried over | {r.get('recovery_ms_to_finished')} ms, restore to finished run |
| Deployment rollback | the previous release's image on the same data volume | healthy; quick check {k['rollback']['quick_check'].get('passed')}/{k['rollback']['quick_check'].get('passed', 0) + k['rollback']['quick_check'].get('failed', 0)}; run still listed: {yes(k['rollback']['run_still_listed'])} | report byte-identical: {yes(k['rollback']['report_identical'])} | {k['recovery_seconds']} s to healthy (roll forward {k['roll_forward']['seconds_to_healthy']} s) |

## 1. Config rollback

The bad change: {c['bad_change']['description']} (`{c['bad_change']['file']}` `{'.'.join(c['bad_change']['path'])}`: `{json.dumps(c['bad_change']['value_before'])}` → `{json.dumps(c['bad_change']['value'])}`).
Tier 1 of the release gate on the bad candidate: **{c['detect']['outcome']}** in {c['detect']['seconds']} s ({'; '.join(c['detect']['blocking'])}).
Rollback: `git checkout {c['release']} -- configs` ({c['rollback']['seconds']} s; configs equal the release: {yes(c['rollback']['configs_equal_release'])}).
Rerun of the representative fixtures (the scripted development suite for both gated systems, and the smoke suite): gate **{c['verify']['outcome']}** in {c['verify']['seconds']} s.
Policy audit trail after the rollback: {trail}.

**Found by this drill:** before TB-042, the gate compared only outcome verdicts. This bad change made record updates run
without their approval pause in both update cases, yet no verdict moved, so the gate passed it. Tier 1 now also compares the
policy audit trail with the committed policy traces and blocks any change that makes it more permissive (a tool executing
more often, or approved or denied less often); a test injects this exact change (`tests/release/test_injected_regressions.py`).

## 2. Service data restore

A real service process accumulated state: {d['state']['runs']} runs, {d['state']['guest_sessions']} guest session, {d['state']['verified_accounts']} verified
account, {d['state']['share_links']} share link. `scripts/backup.py` took a backup **while the service was running** ({d['backup']['seconds']} s, SQLite
online backup). The data directory was then lost. A copy of the backup with one audit record altered
(`{d['damaged_backup']['altered']}`, a decision changed) was refused ("{d['damaged_backup']['refused']}"), and nothing was restored from it.
The real backup was restored ({d['restore']['seconds']} s) and a fresh service started on it in {d['restore']['service_ready_seconds']} s: same runs and artifact hashes,
the account signs in with its password, the guest session and the share link still work, every audit file is byte-identical,
and a new run completes.

## 3. Run-store restore

`{r['test']}`: the durable runner was killed mid-run, its run store backed up, lost and restored, and the run resumed from the
restored copy: records {json.dumps(r.get('records'))}; the same as a control run whose store was never lost. {r['note']}

## 4. Deployment rollback

Staging stack (`{CFG['deploy']['compose_project']}`, own volume; the public demo was not touched). The current image
(`{k['images']['current']['tag']}`) served a run; the previous release's image (`{k['images']['previous']['tag']}`) replaced it on the same
volume in {k['rollback']['seconds_to_healthy']} s to healthy, served the same run with a byte-identical report and passed the quick deployment check;
rolling forward again took {k['roll_forward']['seconds_to_healthy']} s with the data intact.

## Procedures

- Release tags: `release-tb041` is the first; tag each release so a rollback names it.
- Config/code rollback: `git checkout <release> -- configs` (or `git revert`), then `python scripts/release-gate-scripted.py --baseline-ref <release>`.
- Public demo data: `sh deploy/backup-demo.sh` (online, to `backups/` on the project drive); restore with
  `scripts/backup.py restore --backup backups/<name> --dest <dir> --replace` into the volume while the demo is stopped.
- Deployment rollback: `TRUSTBENCH_IMAGE=trustbench-live:<release> docker compose -f deploy/compose.yaml up -d --no-build`.

## Not covered

- Recovery times are for small synthetic state (kilobytes to a few megabytes); they grow with data size. The public demo's
  first real backup: see `backup_of_public_demo` in the JSON.
- Backups live on the same drive as the data; an off-machine copy is not automated.
- A rollback across a change to the stored data format was not exercised (none exists yet between these releases).
"""
    (ROOT / CFG['outputs']['doc']).write_text(doc)


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
    if all(k in out for k in ('config_rollback', 'data_restore', 'run_store_restore', 'deployment_rollback')):
        write_doc(out)


if __name__ == '__main__':
    main()
