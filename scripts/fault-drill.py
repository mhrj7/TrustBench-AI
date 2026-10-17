#!/usr/bin/env python3
"""TB-040: fault and resource-exhaustion drill report.

Collects the results of the fault drills (tests/faults, plus the TB-025 recovery and TB-026 restart suites they build on)
from their JUnit files, the drill measurements the tests record, a measured availability cost of each fail-closed
mechanism added here, and a sensitivity analysis of the confirmatory results to the runs a hung provider ended (which the
corrected runner now marks invalid). Writes evidence/tb040-fault-drill.json and reports/fault-drill.md.

  fault-drill.py                      collect (run `npm run test:faults` first)
  fault-drill.py --staging IMAGE      also run the container drills against the live-service image IMAGE
"""
import importlib.util, json, os, statistics, subprocess, sys, tempfile, time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
CFG = json.loads((ROOT / 'configs/fault-drill.yaml').read_text())


def junit(path: str) -> dict:
    p = ROOT / path
    if not p.exists():
        return {'path': path, 'present': False}
    root = ET.parse(p).getroot()
    cases = root.iter('testcase')
    rows = []
    for c in cases:
        failed = c.find('failure') is not None or c.find('error') is not None
        skipped = c.find('skipped') is not None
        rows.append({'name': c.get('name'), 'status': 'failed' if failed else 'skipped' if skipped else 'passed'})
    return {'path': path, 'present': True, 'modified': datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(timespec='seconds'),
            'passed': sum(r['status'] == 'passed' for r in rows), 'failed': sum(r['status'] == 'failed' for r in rows),
            'skipped': sum(r['status'] == 'skipped' for r in rows), 'tests': rows}


def measurements() -> dict:
    d = ROOT / CFG['measurements_dir']
    return {p.stem: json.loads(p.read_text()) for p in sorted(d.glob('*.json'))} if d.exists() else {}


def audit_overhead() -> dict:
    """Per-call latency of an allowed gateway call without an audit store and with the write-ahead (fsync) audit, in
    alternating blocks so drift affects both equally."""
    import importlib
    spec = CFG['audit_overhead']
    with tempfile.TemporaryDirectory() as tmp:
        os.environ['TRUSTBENCH_TOOL_DB'] = str(Path(tmp) / 'episodes.sqlite')
        os.environ['TRUSTBENCH_TEST_MODE'] = '1'
        sys.modules.pop('src.tools.app', None)
        backend = importlib.import_module('src.tools.app')
        from fastapi.testclient import TestClient
        from src.gateway.app import Gateway
        clients = {}
        for arm, audit in (('no_audit_store', None), ('write_ahead_audit', str(Path(tmp) / 'audit.jsonl'))):
            backend.store.reset(arm, spec['fixture'], 12)
            g = Gateway(backend.app, audit_path=audit)
            clients[arm] = (TestClient(g.app), {'Authorization': 'Bearer ' + g.bind(arm, [spec['tool']])})
        times = {arm: [] for arm in clients}
        for i in range(spec['warmup'] + spec['calls']):
            for arm, (client, headers) in (clients.items() if i % 2 else reversed(list(clients.items()))):
                t = time.perf_counter()
                r = client.post(f'/v1/episodes/{arm}/tools/{spec["tool"]}', headers=headers, json=spec['arguments'])
                dt = (time.perf_counter() - t) * 1000
                assert r.status_code == 200, r.text
                if i >= spec['warmup']:
                    times[arm].append(dt)
    med = {arm: statistics.median(v) for arm, v in times.items()}
    p95 = {arm: sorted(v)[int(0.95 * len(v))] for arm, v in times.items()}
    return {'calls_per_arm': spec['calls'], 'median_ms': {k: round(v, 3) for k, v in med.items()}, 'p95_ms': {k: round(v, 3) for k, v in p95.items()},
            'added_median_ms': round(med['write_ahead_audit'] - med['no_audit_store'], 3), 'storage': 'local APFS volume of the drill host'}


def checkpoint_overhead() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        out = subprocess.run(['node', '--experimental-strip-types', '--no-warnings', str(ROOT / 'scripts/fault-bench-checkpoint.ts'), str(Path(tmp) / 'bench.sqlite'),
                              str(CFG['checkpoint_overhead']['writes'])], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def uncertainty_module():
    spec = importlib.util.spec_from_file_location('estimate_uncertainty', ROOT / 'scripts/estimate-uncertainty.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def hung_runs(spans_path: Path) -> set[str]:
    """Run ids whose run timed out while a model call was still open (the rule in configs/fault-drill.yaml)."""
    runs, calls = {}, {}
    for line in spans_path.read_text().splitlines():
        s = json.loads(line)
        rid = s['attributes'].get('run.id')
        if s['name'] == 'agent.run' and s['attributes'].get('run.outcome') == 'timeout':
            runs[rid] = s['start_ms'] + s['attributes']['run.elapsed_ms']
        elif s['name'] == 'model.call':
            calls.setdefault(rid, []).append((s['start_ms'], s['end_ms']))
    return {rid for rid, at in runs.items() if any(a <= at <= b for a, b in calls.get(rid, []))}


def reclassify(report: dict, hung: set[str]) -> tuple[dict, list[str]]:
    out = json.loads(json.dumps(report))
    changed = []
    for c in out['cases']:
        for arm in ('baseline', 'defended'):
            if f"run-{c['case_id']}-r{c['repetition']}:{arm}" in hung and not c[arm]['invalid']:
                c[arm]['invalid'] = True
                changed.append(f"{c['case_id']}#r{c['repetition']}:{arm}")
    return out, changed


def sensitivity() -> dict:
    mod = uncertainty_module()
    primary = mod.PRIMARY
    rows, total_runs, affected = {}, 0, []
    sets = []
    for record, scope in (('evidence/tb032-holdout-run.json', 'holdout1'), ('evidence/tb032-holdout2-run.json', 'holdout2')):
        rec = json.loads((ROOT / record).read_text())
        for x in rec['renderings']:
            path = ROOT / x['report']
            report = json.loads(path.read_text())
            total_runs += 2 * len(report['cases'])
            fixed, changed = reclassify(report, hung_runs(path.parent / 'spans.jsonl'))
            affected += [{'scope': scope, 'rendering': x['rendering'], 'role': x['role'], 'run': r} for r in changed]
            sets.append((scope, x['rendering'], report, fixed))
    def compare(label, orig, fixed):
        a, b = mod.analyse(label, orig, 'sensitivity'), mod.analyse(label, fixed, 'sensitivity')
        return {'valid_pairs': {'as_recorded': a['valid_pairs'], 'reclassified': b['valid_pairs']},
                **{e: {'as_recorded': {'point': a['endpoints'][e]['paired_difference']['point'], 'ci95': a['endpoints'][e]['paired_difference']['cluster_bootstrap95'],
                                       'baseline': a['endpoints'][e]['baseline']['rate'], 'defended': a['endpoints'][e]['defended']['rate']},
                       'reclassified': {'point': b['endpoints'][e]['paired_difference']['point'], 'ci95': b['endpoints'][e]['paired_difference']['cluster_bootstrap95'],
                                        'baseline': b['endpoints'][e]['baseline']['rate'], 'defended': b['endpoints'][e]['defended']['rate']}}
                   for e in CFG['sensitivity']['endpoints']}}
    for scope in ('holdout1', 'holdout2'):
        o = [r for s, rend, r, _ in sets if s == scope and rend == primary]
        f = [r for s, rend, _, r in sets if s == scope and rend == primary]
        rows[f'{scope}/{primary}'] = compare(f'{scope}/{primary}', o, f)
    o = [r for s, rend, r, _ in sets if rend == primary]
    f = [r for s, rend, _, r in sets if rend == primary]
    rows[f'pooled/{primary}'] = compare(f'pooled/{primary}', o, f)
    return {'rule': CFG['sensitivity']['rule'], 'primary_rendering': primary, 'runs_total': total_runs, 'runs_reclassified': len(affected),
            'share_reclassified': round(len(affected) / total_runs, 4), 'affected': affected, 'primary_analyses': rows,
            'note': 'The registered results (TB-032..TB-034) are not rewritten: they were produced and analysed under the protocol as frozen. This is a sensitivity analysis of how much the corrected classification would move them.'}


def staging(image: str) -> dict:
    """Container drills against the live-service image: no network for a live run, a run cancelled mid-flight, and a
    read-only service data volume."""
    import urllib.request
    def http(port, method, path, body=None, token=None):
        req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'content-type': 'application/json', **({'authorization': f'Bearer {token}'} if token else {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')
    def up(name, port, extra):
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
        subprocess.run(['docker', 'run', '-d', '--name', name, '-p', f'127.0.0.1:{port}:8080', *extra, image], check=True, capture_output=True)
        for _ in range(120):
            try:
                if http(port, 'GET', '/api/catalog')[0] == 200:
                    return
            except Exception:
                pass
            time.sleep(1)
        raise RuntimeError(f'{name} did not start: ' + subprocess.run(['docker', 'logs', name], capture_output=True, text=True).stderr[-800:])
    def ps(name):
        out = subprocess.run(['docker', 'exec', name, 'ps', '-eo', 'pid,comm'], capture_output=True, text=True)
        if out.returncode:  # slim images may lack ps: read /proc instead
            out = subprocess.run(['docker', 'exec', name, 'sh', '-c', 'for p in /proc/[0-9]*; do printf "%s %s\\n" "${p#/proc/}" "$(cat $p/comm 2>/dev/null)"; done'], capture_output=True, text=True)
        return sorted(l.split(None, 1)[1] for l in out.stdout.strip().splitlines()[1:] if len(l.split(None, 1)) == 2)
    def wait(port, job, token, limit=600):
        t = time.time()
        while time.time() - t < limit:
            s = http(port, 'GET', f'/api/runs/{job}', token=token)[1]
            if s.get('status') not in ('queued', 'running'):
                return s, time.time() - t
            time.sleep(1)
        raise RuntimeError('run did not finish')
    result = {'image': image, 'image_id': subprocess.run(['docker', 'image', 'inspect', '-f', '{{.Id}}', image], capture_output=True, text=True).stdout.strip()[:19]}
    port = 18471
    try:
        # 1. no network: a live own-key run (a dummy key that only matters if the provider were reachable)
        up('tb040-nonet', port, ['--network', 'none'])
        tok = http(port, 'POST', '/api/session')[1]['token']
        cat = http(port, 'GET', '/api/catalog')[1]
        model = cat['modes']['own_key']['models'][0]['id']
        code, job = http(port, 'POST', '/api/runs', {'mode': 'own_key', 'model': model, 'api_key': 'drill-dummy-key-not-real-0000', 'system': 'gateway_capability',
                                                       'cases': ['doc-benign', 'doc-attack']}, tok)
        s, took = wait(port, job['id'], tok)
        result['no_network_live_run'] = {'submit_status': code, 'status': s['status'], 'error': s.get('error'), 'seconds': round(took, 1),
                                         'valid_pairs': (s.get('summary') or {}).get('valid_pairs'), 'invalid_pairs': (s.get('summary') or {}).get('invalid_pairs'),
                                         'invalid_reasons': (s.get('summary') or {}).get('invalid_reasons')}
        # 2. cancel a running scripted run and look for leftover processes
        base = ps('tb040-nonet')
        cases = [c['id'] for c in cat['cases']][:cat['modes']['scripted']['limits']['max_pairs_per_run']]
        code, job = http(port, 'POST', '/api/runs', {'mode': 'scripted', 'system': 'gateway_capability', 'cases': cases, 'repetitions': 2}, tok)
        during = []
        for _ in range(120):
            during = ps('tb040-nonet')
            if http(port, 'GET', f'/api/runs/{job["id"]}', token=tok)[1].get('status') == 'running' and len(during) > len(base) + 1:
                break
            time.sleep(0.5)
        t = time.time()
        dcode, deleted = http(port, 'DELETE', f'/api/runs/{job["id"]}', token=tok)
        stop_s = time.time() - t
        time.sleep(2)
        after = ps('tb040-nonet')
        result['cancel_running_run'] = {'delete_status': dcode, 'files_removed': deleted.get('files_removed'), 'stop_seconds': round(stop_s, 2),
                                        'processes_idle': len(base), 'processes_during_run': len(during), 'processes_after_delete': len(after),
                                        'leftover': sorted(set(after) - set(base)), 'get_after_delete': http(port, 'GET', f'/api/runs/{job["id"]}', token=tok)[0]}
    finally:
        subprocess.run(['docker', 'rm', '-f', 'tb040-nonet'], capture_output=True)
    try:
        # 3. the service data volume is read-only (a full or failed disk): the site still serves, runs are refused explicitly
        up('tb040-ro', port, ['--tmpfs', '/workspace/service-data:ro'])
        cat = http(port, 'GET', '/api/catalog')
        sess = http(port, 'POST', '/api/session')
        token = sess[1].get('token')
        run = http(port, 'POST', '/api/runs', {'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['doc-benign']}, token) if token else (None, {})
        result['read_only_storage'] = {'catalog_status': cat[0], 'session_status': sess[0], 'session_detail': sess[1].get('detail'), 'run_status': run[0], 'run_detail': run[1].get('detail')}
    except RuntimeError as e:
        result['read_only_storage'] = {'service_started': False, 'detail': str(e)[-600:]}
    finally:
        subprocess.run(['docker', 'rm', '-f', 'tb040-ro'], capture_output=True)
    return result


def write_doc(out):
    s, a, c, m = out['sensitivity'], out['availability_cost']['write_ahead_audit'], out['availability_cost']['checkpoint_integrity'], out['measurements']
    suites = '\n'.join(f"| {k} | {v['fault']} | {v['passed']} | {v['failed']} | {v['skipped']} | `{v['path']}` |" for k, v in out['suites'].items())
    def pp(x):
        return 'n/a' if x is None else f'{x * 100:+.1f}'
    def ci(x):
        return 'n/a' if not x else f'[{x[0] * 100:+.1f}, {x[1] * 100:+.1f}]'
    sens = '\n'.join(f"| {k} | {e} | {v['valid_pairs']['as_recorded']} → {v['valid_pairs']['reclassified']} | {pp(v[e]['as_recorded']['point'])} {ci(v[e]['as_recorded']['ci95'])} | {pp(v[e]['reclassified']['point'])} {ci(v[e]['reclassified']['ci95'])} |"
                     for k, v in s['primary_analyses'].items() for e in CFG['sensitivity']['endpoints'])
    st = out.get('staging')
    staging_md = 'Not run in this collection (use `--staging IMAGE`).' if not st else '\n'.join([
        f"Image `{st['image']}` ({st['image_id']}).", '',
        f"- **No network, live own-key run:** submitted {st['no_network_live_run']['submit_status']}; ended `{st['no_network_live_run']['status']}` after {st['no_network_live_run']['seconds']} s with {st['no_network_live_run']['valid_pairs']} valid and {st['no_network_live_run']['invalid_pairs']} invalid pairs; reasons: {', '.join(r['code'] + ' (' + str(r['runs']) + ' runs)' for r in st['no_network_live_run']['invalid_reasons'] or []) or st['no_network_live_run']['error']}.",
        f"- **Cancel a running run:** DELETE returned {st['cancel_running_run']['delete_status']} in {st['cancel_running_run']['stop_seconds']} s and removed {st['cancel_running_run']['files_removed']} files; processes idle {st['cancel_running_run']['processes_idle']}, during the run {st['cancel_running_run']['processes_during_run']}, after the delete {st['cancel_running_run']['processes_after_delete']} (leftover: {', '.join(st['cancel_running_run']['leftover']) or 'none'}); the run then answers {st['cancel_running_run']['get_after_delete']}.",
        '- **Read-only service storage:** ' + (f"the catalog answers {st['read_only_storage']['catalog_status']}; creating a session answers {st['read_only_storage']['session_status']} ({st['read_only_storage']['session_detail']}); starting a run answers {st['read_only_storage']['run_status']} ({st['read_only_storage']['run_detail']})."
                                               if st['read_only_storage'].get('service_started', True) else f"the service did not start: {st['read_only_storage']['detail']}")])
    hang, cancel = m.get('model-hang', {}), m.get('cancel', {})
    doc = f"""# Fault drill (TB-040)

Generated by `scripts/fault-drill.py` from the drill suites' JUnit files, the measurements the drills record, and the
confirmatory run records. Commit `{out['commit']}`, {out['generated_at']}. Machine-readable copy: `{CFG['outputs']['json']}`.

Acceptance: *failures produce explicit status and do not bypass policy.* Result: **{'met' if out['acceptance']['met'] else 'NOT met'}**
({out['acceptance']['passed']} drill tests passed, {out['acceptance']['failed']} failed, {out['acceptance']['skipped']} skipped).

## Drills

| Suite | Faults | Passed | Failed | Skipped | JUnit |
|---|---|---|---|---|---|
{suites}

What each fault does now:

- **Unavailable model** (`tests/faults/test_model_unavailable.py`, the real runner pointed at a loopback stub): connection
  refused gives `network`, HTTP 503 gives `server`, a provider that never answers gives `timeout` on the model node. Every
  pair is invalid (never counted as secure or useful), no tool runs, and the gateway arm records no allow decision. The hung
  provider ended at the run timeout ({hang.get('run_timeout_ms', 'n/a')} ms per arm; whole drill {hang.get('elapsed_s', 'n/a')} s against a {hang.get('stub_hang_s', 'n/a')} s hang).
  A drill URL must be loopback and is refused for the confirmatory holdout.
- **Corrupt checkpoint** (`tests/faults/checkpoint.test.ts`, the real durable runner killed mid-run, then its SQLite record
  damaged): an injected tool call, a torn write and a removed checksum all end the resumed run with `checkpoint_corrupt`,
  no tool call and no model call; an altered final outcome is reported corrupt instead of being returned or re-run.
- **Tool crash** (`tests/faults/test_gateway_faults.py`): the gateway answers 502 `tool_backend_error`, records
  `executed: false` with the exception type, commits nothing, and serves the next call normally.
- **Log-store failure**: every allowed call is written to a write-ahead intent log and fsynced before the tool runs; if
  that write fails the call is denied with 503 `audit_unavailable` and nothing executes (fail closed). The in-memory trail
  is flushed when the store is writable again, so the denial itself is logged.
- **Cancellation** (`tests/faults/test_service_faults.py`): deleting a running run stops its whole process group (the
  runner and the gateway and tool services it started; {cancel.get('processes_in_run_group_before', 'n/a')} processes in {cancel.get('stop_seconds', 'n/a')} s) and removes every
  artifact. A runner that ignores SIGTERM is killed with its children (the old terminate-only stop leaves the child
  running; verified by running the drill against it). The TB-026 cancellation marker and kill/restart drills still pass.
- **Resource exhaustion:** unwritable service storage refuses new runs with 503 `storage_unavailable` before any shared
  budget is reserved; a damaged shared-budget record pauses the shared key (counted as spent) instead of resetting it,
  while scripted and own-key runs stay available; step, token, retry and time budgets end runs explicitly (TB-015/TB-025
  suites, plus a tool that never returns, which now ends with `AgentTimeoutError` and outcome `timeout`).

## Staging (container)

{staging_md}

## Availability cost of failing closed

- **Write-ahead audit:** median allowed-call latency {a['median_ms']['no_audit_store']} ms without an audit store and
  {a['median_ms']['write_ahead_audit']} ms with it (+{a['added_median_ms']} ms; p95 {a['p95_ms']['no_audit_store']} → {a['p95_ms']['write_ahead_audit']} ms; {a['calls_per_arm']} calls per arm, {a['storage']}).
  While the log store is down, every allowed call is refused: availability of tool calls is zero for that time, by design.
- **Checkpoint integrity:** a {c['checkpoint_bytes']}-byte checkpoint takes {c['write_median_us']} µs to write durably, of which the SHA-256 is
  {c['sha256_median_us']} µs (median of {c['writes']}). A corrupt checkpoint costs the whole run: it ends as a failure and must be re-run.
- **Hung provider:** a run whose model call does not answer now becomes invalid and must be re-run instead of being scored.
  In the confirmatory runs that is {s['runs_reclassified']} of {s['runs_total']} runs ({s['share_reclassified'] * 100:.1f}%).
- **Damaged budget record:** the shared key is unavailable until the record is repaired (visitors fall back to scripted
  or own-key runs).

## Sensitivity of the confirmatory results to hung-provider runs

{s['rule']}

{s['runs_reclassified']} of {s['runs_total']} confirmatory runs match. Paired difference (defended − baseline, percentage points, cluster
bootstrap 95%) on the primary rendering `{s['primary_rendering']}`, as recorded and with those pairs excluded:

| Analysis | Endpoint | Valid pairs | As recorded | Reclassified |
|---|---|---|---|---|
{sens}

{s['note']}

## Not covered

{chr(10).join('- ' + x for x in out['not_covered'])}
"""
    (ROOT / CFG['outputs']['doc']).write_text(doc)


def main():
    out = {'task_id': 'TB-040', 'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
           'commit': subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.strip(),
           'suites': {k: {**junit(v['junit']), 'fault': v['fault']} for k, v in CFG['suites'].items()}}
    missing = [k for k, v in out['suites'].items() if not v['present']]
    if missing:
        sys.exit(f'missing drill results for {missing}: run npm run test:faults (and test:recovery, test:restart) first')
    out['acceptance'] = {'passed': sum(v['passed'] for v in out['suites'].values()), 'failed': sum(v['failed'] for v in out['suites'].values()),
                         'skipped': sum(v['skipped'] for v in out['suites'].values())}
    out['acceptance']['met'] = out['acceptance']['failed'] == 0 and out['acceptance']['skipped'] == 0
    out['measurements'] = measurements()
    out['availability_cost'] = {'write_ahead_audit': audit_overhead(), 'checkpoint_integrity': checkpoint_overhead()}
    out['sensitivity'] = sensitivity()
    prior = ROOT / CFG['outputs']['json']
    if '--staging' in sys.argv:
        out['staging'] = staging(sys.argv[sys.argv.index('--staging') + 1])
    elif prior.exists():
        out['staging'] = json.loads(prior.read_text()).get('staging')
    out['not_covered'] = [
        'A checkpoint rewritten together with a recomputed checksum by someone with write access to the run store: the checksum detects damage and naive edits, not a writer who can also recompute it (that needs a keyed MAC with the key outside the store).',
        'Disk-full on the run store (SQLite) itself was not simulated; a read-only audit file and a read-only service volume stand in for a failing disk.',
        'Real provider outages were not induced; the provider faults are a loopback stub reached through the drill hook, which is refused for confirmatory runs.',
        'Memory and CPU exhaustion of the host were not drilled.',
    ]
    prior.write_text(json.dumps(out, indent=1) + '\n')
    write_doc(out)
    print(json.dumps({'acceptance': out['acceptance'], 'reclassified': out['sensitivity']['runs_reclassified'], 'audit_added_ms': out['availability_cost']['write_ahead_audit']['added_median_ms'],
                      'staging': bool(out.get('staging'))}))
    if not out['acceptance']['met']:
        sys.exit(1)


if __name__ == '__main__':
    main()
