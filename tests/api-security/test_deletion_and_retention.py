"""TB-039 acceptance: deletion removes every linked artifact; the retention job deletes what expired."""
import time

from conftest import SCRIPTED


def run_files(world, rid):
    d = world.data / 'jobs' / rid
    return [p for p in d.rglob('*') if p.is_file()] if d.exists() else []


def test_deleting_a_run_removes_record_report_evaluation_spans_traces_and_logs(world):
    alice = world.user('alice').guest()
    rid = alice.run()['id']
    files = run_files(world, rid)
    names = {p.name for p in files}
    assert {'job.json', 'report.json', 'evaluation.json', 'spans.jsonl', 'policy-traces.jsonl', 'runner.log'} <= names
    r = alice.delete(f'/api/runs/{rid}')
    assert r.status_code == 200 and r.json()['files_removed'] == len(files)
    assert run_files(world, rid) == [] and not (world.data / 'jobs' / rid).exists()
    for path in (f'/api/runs/{rid}', f'/api/runs/{rid}/report', f'/api/runs/{rid}/evaluation'):
        assert alice.get(path).status_code == 404
    assert alice.get('/api/runs').json() == []
    assert rid not in world.service.jobs


def test_deleting_a_queued_or_running_run_stops_it_and_leaves_nothing(world):
    alice = world.user('alice').guest()
    job = alice.run(SCRIPTED | {'cases': ['doc-benign', 'doc-attack', 'email-benign', 'email-attack-recipient']}, wait=False)
    assert alice.delete(f"/api/runs/{job['id']}").status_code == 200
    time.sleep(3)  # give a worker time to pick it up or finish: nothing may reappear
    assert run_files(world, job['id']) == [] and alice.get(f"/api/runs/{job['id']}").status_code == 404


def test_a_guest_deleting_its_session_removes_all_its_runs(world):
    alice, bob = world.user('alice').guest(), world.user('bob').guest()
    mine = [alice.run()['id'], alice.run()['id']]
    bobs = bob.run()['id']
    r = alice.delete('/api/session')
    assert r.status_code == 200 and r.json()['deleted_runs'] == 2
    assert all(run_files(world, i) == [] for i in mine) and run_files(world, bobs)
    assert alice.get('/api/runs').status_code == 401  # the session itself is gone


def test_deleting_an_account_removes_its_runs_sessions_and_user(world):
    alice = world.account('alice', 'alice@example.invalid')
    rid = alice.run()['id']
    assert alice.request('DELETE', '/api/auth/account', json={'password': 'wrong password entirely'}).status_code == 401
    r = alice.request('DELETE', '/api/auth/account', json={'password': 'correct horse battery staple 42'})
    assert r.status_code == 200 and r.json()['deleted_runs'] == 1
    assert run_files(world, rid) == []
    assert world.service.accounts.by_email('alice@example.invalid') is None
    assert alice.get('/api/runs').status_code == 401
    assert world.user('x').post('/api/auth/login', json={'email': 'alice@example.invalid', 'password': 'correct horse battery staple 42'}).status_code == 401


def test_retention_job_deletes_expired_guest_runs_and_sessions_but_keeps_account_runs(world):
    guest, alice = world.user('guest').guest(), world.account('alice', 'alice@example.invalid')
    g, a = guest.run()['id'], alice.run()['id']
    hours = world.service.sweep(time.time() + (world.service.sessions.ttl_s + 60))  # past the guest session lifetime
    assert hours['runs_deleted'] >= 1 and run_files(world, g) == [] and run_files(world, a)
    days = world.service.sweep(time.time() + 31 * 86400)  # past the account retention
    assert run_files(world, a) == [] and days['runs_deleted'] >= 1
