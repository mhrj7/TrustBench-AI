#!/usr/bin/env python3
"""TB-041: acceptance check of a TrustBench demo deployment, from the outside, as a reviewer with no API key would use it.

  check-deployment.py --url https://<site> [--live] [--exhaust] [--out evidence.json]

Checks, each recorded as passed or failed with what was observed:
  health and site      /api/health, the site pages, security headers (HSTS too when the URL is https)
  catalog              no sealed holdout case, the deployment profile and its limits, which modes are available
  authentication       run creation needs a session; operator endpoints refuse no token and a forged token; another
                       visitor's session cannot see a run (404); an oversize request is refused (413)
  instant run          a scripted run from the HTTP API (what the website does) and from the CLI (trustbench remote)
  live run (--live)    a hosted run with the project's key, from the API and from the CLI; a visitor key that the provider
                       rejects gives an explicit invalid run, not a silent pass
  budget (--exhaust)   only for a staging deployment with a tiny daily budget: once it is spent, hosted mode reports why
                       and refuses runs (429) while instant and own-key runs stay available
  rate limit           scripted submissions per visitor stop at the profile's hourly limit (429); the probe runs are deleted
Exit 1 if any check fails."""
import argparse, json, os, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEALED = set(json.loads((ROOT / 'data/splits.json').read_text())['holdout_manifest']['fixture_ids'])
REPORT_SCHEMA = json.loads((ROOT / 'schemas/arm-report.schema.json').read_text())


class Site:
    def __init__(self, url):
        self.url = url.rstrip('/')

    def call(self, method, path, body=None, token=None, raw=False, headers=None):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        h = {'content-type': 'application/json', 'user-agent': 'trustbench-deploy-check', **(headers or {})}
        if token:
            h['authorization'] = f'Bearer {token}'
        req = urllib.request.Request(self.url + path, method=method, data=data, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                payload = r.read()
                return r.status, (payload if raw else json.loads(payload or b'{}')), dict(r.headers)
        except urllib.error.HTTPError as e:
            payload = e.read()
            try:
                payload = payload if raw else json.loads(payload or b'{}')
            except ValueError:
                pass
            return e.code, payload, dict(e.headers)

    def session(self):
        return self.call('POST', '/api/session')[1]['token']

    def wait(self, job, token, limit_s=900):
        t = time.time()
        while time.time() - t < limit_s:
            s = self.call('GET', f'/api/runs/{job}', token=token)[1]
            if s.get('status') not in ('queued', 'running'):
                return s, round(time.time() - t, 1)
            time.sleep(2)
        raise TimeoutError(f'run {job} did not finish in {limit_s} s')


class Checks:
    def __init__(self):
        self.rows = []

    def check(self, name, ok, observed):
        self.rows.append({'check': name, 'passed': bool(ok), 'observed': observed})
        print(('PASS ' if ok else 'FAIL ') + name + ': ' + json.dumps(observed)[:300], flush=True)
        return ok


def cli(url, *args, env=None):
    p = subprocess.run(['sh', str(ROOT / 'bin/trustbench'), 'remote', *args, '--url', url], cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, 'TRUSTBENCH_CLI_HOME': str(ROOT / '.tool-state' / 'deploy-check-cli'), **(env or {})}, timeout=1200)
    job, text, dec = {}, p.stdout, json.JSONDecoder()  # the CLI prints the submission, then (with --wait) the finished run
    i = text.find('{')
    while i != -1:
        try:
            job, end = dec.raw_decode(text, i)
        except ValueError:
            end = i + 1
        i = text.find('{', end)
    return p.returncode, job, p.stderr[-400:]


def run_summary(s):
    summary = s.get('summary') or {}
    return {'status': s.get('status'), 'error': s.get('error'), 'mode': s.get('mode'), 'pairs': s.get('pairs'), 'valid_pairs': summary.get('valid_pairs'),
            'invalid_pairs': summary.get('invalid_pairs'), 'invalid_reasons': [r['code'] for r in summary.get('invalid_reasons') or []],
            'observed_models': summary.get('observed_response_models')}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', required=True)
    ap.add_argument('--live', action='store_true', help='also run hosted and own-key checks (uses the deployment\'s free-tier quota)')
    ap.add_argument('--exhaust', action='store_true', help='staging only: spend the (tiny) hosted budget and check the degradation')
    ap.add_argument('--quick', action='store_true', help='health, pages, headers, catalog and authentication only: no runs (for scheduled monitoring)')
    ap.add_argument('--out')
    a = ap.parse_args()
    site, c = Site(a.url), Checks()

    # health and site
    code, health, _ = site.call('GET', '/api/health')
    c.check('health', code == 200 and health.get('ok') is True, {'status': code, 'body': health})
    for page in ('/', '/live', '/account'):
        code, body, headers = site.call('GET', page, raw=True)
        lower = {k.lower(): v for k, v in headers.items()}
        want = ['content-security-policy', 'x-frame-options', 'referrer-policy', 'x-content-type-options'] + (['strict-transport-security'] if a.url.startswith('https') else [])
        c.check(f'site page {page}', code == 200 and b'<div id="root"' in body and all(h in lower for h in want),
                {'status': code, 'missing_headers': [h for h in want if h not in lower]})

    # the launch film the Overview page plays: served as video, with byte ranges (seeking), and its poster
    code, body, headers = site.call('GET', '/media/trustbench-launch.mp4', raw=True, headers={'range': 'bytes=0-1023'})
    lower = {k.lower(): v for k, v in headers.items()}
    c.check('launch film is served as video with byte ranges', code == 206 and lower.get('content-type', '').startswith('video/mp4') and len(body) == 1024 and body[4:8] == b'ftyp',
            {'status': code, 'content_type': lower.get('content-type'), 'bytes': len(body)})
    code, body, headers = site.call('GET', '/media/trustbench-launch-poster.jpg', raw=True)
    c.check('launch film poster is served', code == 200 and {k.lower(): v for k, v in headers.items()}.get('content-type', '').startswith('image/jpeg'), {'status': code})

    # catalog
    code, cat, _ = site.call('GET', '/api/catalog')
    exposed = [x['id'] for x in cat.get('cases', []) if x['id'].upper().replace('-', '') in {s.upper().replace('-', '') for s in SEALED}]
    c.check('catalog lists no sealed holdout case', code == 200 and not exposed and 'sealed' in cat.get('holdouts', ''), {'cases': len(cat.get('cases', [])), 'sealed_exposed': exposed})
    c.check('catalog reports the deployment profile', bool(cat.get('deploy_profile')), {'deploy_profile': cat.get('deploy_profile'), 'limits': {m: v['limits'] for m, v in cat['modes'].items()}})
    c.check('instant and own-key modes are available', cat['modes']['scripted']['available'] and cat['modes']['own_key']['available'],
            {m: (v['available'], v['reason']) for m, v in cat['modes'].items()})
    c.check('no secret material in the catalog', not any(k in json.dumps(cat).lower() for k in ('nvapi-', 'aiza', 'api_key":', 'admin_token')), {})

    # authentication
    code, body, _ = site.call('POST', '/api/runs', {'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['doc-benign']})
    c.check('run creation without a session is refused', code == 401, {'status': code})
    for label, token in (('no token', None), ('forged token', 'forged-' + 'x' * 40)):
        code, _, _ = site.call('GET', '/api/admin/runs', token=token)
        c.check(f'operator endpoint refuses {label}', code in (401, 403, 404), {'status': code, 'note': 'answers 404 by design: it does not reveal that the endpoint exists'})
    code, _, _ = site.call('POST', '/api/runs', b'{"pad": "' + b'x' * 70000 + b'"}', token=site.session())
    c.check('oversize request refused', code == 413, {'status': code})

    if a.quick:
        return finish(a, c)

    # instant run from the API (the website's path)
    token = site.session()
    systems = [s['id'] for s in cat['systems'] if 'scripted' in s['modes']]
    code, job, _ = site.call('POST', '/api/runs', {'mode': 'scripted', 'system': systems[0], 'cases': ['doc-benign', 'doc-attack']}, token)
    s, took = site.wait(job['id'], token) if code == 202 else ({'status': f'submit {code}', 'error': job}, 0)
    c.check('instant run (API)', s['status'] == 'done' and (s.get('summary') or {}).get('valid_pairs') == 2, {**run_summary(s), 'seconds': took})
    code, report, _ = site.call('GET', f"/api/runs/{job['id']}/report", token=token)
    import jsonschema
    problems = [e.message for e in jsonschema.Draft202012Validator(REPORT_SCHEMA).iter_errors(report)][:3] if code == 200 else ['not fetched']
    c.check('instant run report is valid against schemas/arm-report.schema.json', code == 200 and not problems and len(report.get('cases', [])) == 2, {'status': code, 'problems': problems})
    code, _, _ = site.call('GET', f"/api/runs/{job['id']}", token=site.session())
    c.check("another visitor cannot see the run", code == 404, {'status': code})

    # instant run from the CLI
    rc, out, err = cli(a.url, 'run', '--mode', 'scripted', '--cases', 'doc-benign,doc-attack', '--wait')
    c.check('instant run (CLI trustbench remote)', rc == 0 and out.get('status') == 'done' and (out.get('summary') or {}).get('valid_pairs') == 2, {'exit': rc, **run_summary(out), 'stderr': err if rc else ''})

    if a.live:
        hosted = cat['modes']['hosted']
        model = hosted['models'][0]['id'] if hosted['models'] else None
        if not hosted['available']:
            c.check('live run with the project key (API)', False, {'hosted_available': False, 'reason': hosted['reason']})
        else:
            n = hosted['limits']['max_pairs_per_run']
            cases = ['doc-benign', 'doc-attack'][:n]
            code, job, _ = site.call('POST', '/api/runs', {'mode': 'hosted', 'model': model, 'system': 'gateway_capability', 'cases': cases}, token)
            s, took = site.wait(job['id'], token) if code == 202 else ({'status': f'submit {code}', 'error': job}, 0)
            c.check('live run with the project key (API)', s['status'] in ('done', 'done_with_parity_warnings') and (s.get('summary') or {}).get('valid_pairs', 0) > 0 and s.get('key_source') == 'project',
                    {**run_summary(s), 'seconds': took, 'key_source': s.get('key_source')})
            rc, out, err = cli(a.url, 'run', '--mode', 'hosted', '--model', model, '--cases', cases[0], '--wait')
            c.check('live run with the project key (CLI)', rc == 0 and out.get('status') in ('done', 'done_with_parity_warnings') and (out.get('summary') or {}).get('valid_pairs', 0) > 0,
                    {'exit': rc, **run_summary(out), 'stderr': err if rc else ''})
        own = cat['modes']['own_key']['models'][0]['id']
        rc, out, err = cli(a.url, 'run', '--mode', 'own_key', '--model', own, '--cases', 'doc-benign', '--key-env', 'TB_CHECK_FAKE_KEY', '--wait',
                           env={'TB_CHECK_FAKE_KEY': 'deploy-check-not-a-real-key-000000'})
        c.check('a rejected visitor key gives an explicit invalid run', rc == 0 and (out.get('summary') or {}).get('valid_pairs') == 0 and 'authentication' in run_summary(out)['invalid_reasons'],
                {'exit': rc, **run_summary(out), 'stderr': err if rc else ''})

    if a.exhaust:
        cat = site.call('GET', '/api/catalog')[1]
        hosted = cat['modes']['hosted']
        model = hosted['models'][0]['id'] if hosted['models'] else None
        spent = []
        while hosted['available'] and len(spent) < 10:
            n = min(hosted['limits']['max_pairs_per_run'], hosted['remaining_pairs_today'])
            code, job, _ = site.call('POST', '/api/runs', {'mode': 'hosted', 'model': model, 'system': 'gateway_capability', 'cases': ['doc-benign', 'doc-attack'][:n]}, token)
            if code != 202:
                break
            spent.append(run_summary(site.wait(job['id'], token)[0]))
            hosted = site.call('GET', '/api/catalog')[1]['modes']['hosted']
        cat = site.call('GET', '/api/catalog')[1]
        code, body, _ = site.call('POST', '/api/runs', {'mode': 'hosted', 'model': model, 'system': 'gateway_capability', 'cases': ['doc-benign']}, token)
        c.check('exhausted shared budget: hosted refuses with a clear message', code == 429 and not cat['modes']['hosted']['available'] and 'budget' in (cat['modes']['hosted']['reason'] or ''),
                {'runs_spending_budget': spent, 'status': code, 'detail': body.get('detail') if isinstance(body, dict) else body, 'reason': cat['modes']['hosted']['reason']})
        c.check('exhausted shared budget: instant and own-key stay available', cat['modes']['scripted']['available'] and cat['modes']['own_key']['available'], {})
        code, job, _ = site.call('POST', '/api/runs', {'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['doc-benign']}, token)
        c.check('exhausted shared budget: an instant run still starts', code == 202, {'status': code})

    # rate limit on scripted submissions (probe runs are deleted straight away)
    limit = cat['modes']['scripted']['limits']['per_client_runs_per_hour']
    probe, codes, ids, detail = site.session(), [], [], None
    for _ in range(limit + 2):
        code, job, _ = site.call('POST', '/api/runs', {'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['doc-benign']}, probe)
        codes.append(code)
        if code == 202:
            ids.append(job['id'])
        if code == 429:
            detail = job.get('detail')
            break
    deleted = [site.call('DELETE', f'/api/runs/{i}', token=probe)[0] for i in ids]
    c.check('per-visitor rate limit stops instant runs', 429 in codes and codes.count(202) <= limit and all(d == 200 for d in deleted),
            {'client_limit_per_hour': limit, 'accepted_before_429': codes.count(202), 'limit_that_applied': detail, 'probe_runs_deleted': len(deleted),
             'note': 'the stricter of the per-client and per-session limits applies first'})

    finish(a, c)


def finish(a, c):
    out = {'task_id': 'TB-041', 'url': a.url, 'checked_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'live': a.live, 'exhaust': a.exhaust,
           'quick': a.quick, 'vantage': os.environ.get('TRUSTBENCH_CHECK_VANTAGE', 'unspecified'),
           'passed': sum(r['passed'] for r in c.rows), 'failed': sum(not r['passed'] for r in c.rows), 'checks': c.rows}
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps({'passed': out['passed'], 'failed': out['failed']}))
    sys.exit(1 if out['failed'] else 0)


if __name__ == '__main__':
    main()
