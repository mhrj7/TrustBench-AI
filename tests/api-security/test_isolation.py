"""TB-039 acceptance: unauthorized read and run requests fail; runs are isolated per user."""
from conftest import SCRIPTED


def test_anonymous_callers_cannot_run_or_list(world):
    anon = world.user('anon')
    assert anon.post('/api/runs', json=SCRIPTED).status_code == 401
    assert anon.get('/api/runs').status_code == 401
    assert anon.post('/api/runs', json=SCRIPTED, headers={'Authorization': 'Bearer forged-token-0000000000'}).status_code == 401
    assert anon.get('/api/catalog').status_code == 200 and anon.get('/api/health').status_code == 200  # public, read-only


def test_one_user_cannot_read_list_share_or_delete_another_users_run(world):
    alice, bob = world.user('alice').guest(), world.user('bob').guest()
    run = alice.run()
    rid = run['id']
    assert run['status'] == 'done'
    for path in (f'/api/runs/{rid}', f'/api/runs/{rid}/report', f'/api/runs/{rid}/evaluation', f'/api/runs/{rid}/spans'):
        assert alice.get(path).status_code == 200
        r = bob.get(path)
        assert r.status_code == 404 and r.json()['detail'] in ('unknown run',)  # forbidden looks exactly like missing
    assert bob.post(f'/api/runs/{rid}/share').status_code == 404
    assert bob.delete(f'/api/runs/{rid}').status_code == 404
    assert [j['id'] for j in alice.get('/api/runs').json()] == [rid]
    assert bob.get('/api/runs').json() == []


def test_probing_run_ids_reveals_nothing(world):
    alice, attacker = world.user('alice').guest(), world.user('attacker').guest()
    rid = alice.run()['id']
    real, fake = attacker.get(f'/api/runs/{rid}'), attacker.get('/api/runs/' + '0' * 24)
    assert real.status_code == fake.status_code == 404 and real.json() == fake.json()
    for path in ('/api/runs/../../etc/passwd', '/..%2F..%2F..%2Fetc%2Fpasswd', '/assets/..%2F..%2F..%2Fetc%2Fpasswd', '/api/runs/%2E%2E%2Fjobs/report'):
        r = attacker.get(path)
        assert 'root:' not in r.text and 'job.json' not in r.text  # never a file outside the site: at most the site's index page


def test_share_token_grants_read_only_until_revoked(world):
    alice, bob = world.user('alice').guest(), world.user('bob').guest()
    rid = alice.run()['id']
    share = alice.post(f'/api/runs/{rid}/share').json()['share_token']
    h = {'X-TrustBench-Share': share}
    assert bob.get(f'/api/runs/{rid}/report', headers=h).status_code == 200
    assert world.user('anon').get(f'/api/runs/{rid}', headers=h).status_code == 200  # no session needed to read a shared run
    assert bob.delete(f'/api/runs/{rid}', headers=h).status_code == 404  # sharing never grants deletion
    assert bob.post(f'/api/runs/{rid}/share', headers=h).status_code == 404  # nor re-sharing
    assert bob.get(f'/api/runs/{rid}', headers={'X-TrustBench-Share': share + 'x'}).status_code == 404
    assert alice.delete(f'/api/runs/{rid}/share').status_code == 200
    assert bob.get(f'/api/runs/{rid}/report', headers=h).status_code == 404


def test_account_runs_follow_the_account_across_sessions_and_not_to_others(world):
    alice_laptop = world.account('alice', 'alice@example.invalid')
    rid = alice_laptop.run()['id']
    alice_phone = world.user('alice-phone')
    token = alice_phone.post('/api/auth/login', json={'email': 'alice@example.invalid', 'password': 'correct horse battery staple 42'}).json()['token']
    alice_phone.use(token)
    assert alice_phone.get(f'/api/runs/{rid}/report').status_code == 200
    mallory = world.account('mallory', 'mallory@example.invalid')
    assert mallory.get(f'/api/runs/{rid}').status_code == 404


def test_operator_endpoints_are_invisible_without_the_operator_token(world, monkeypatch):
    alice = world.user('alice').guest()
    alice.run()
    assert alice.get('/api/admin/runs').status_code == 404
    monkeypatch.setenv('TRUSTBENCH_ADMIN_TOKEN', 'operator-token-for-tests-123456')
    op = world.user('operator').use('operator-token-for-tests-123456')
    listed = op.get('/api/admin/runs').json()
    assert len(listed) == 1 and 'owner' in listed[0]
    assert op.delete(f"/api/runs/{listed[0]['id']}").status_code == 200
