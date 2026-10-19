"""TB-039: request quotas (sessions, runs, sign-in attempts, the shared budget) and HTTP hardening."""
import pytest

import src.service.app as svc_mod
from src.service.app import ACC, AUTH, CFG

from conftest import SCRIPTED


def test_new_sessions_are_limited_per_client(world, monkeypatch):
    monkeypatch.setitem(AUTH, 'sessions_per_client_per_hour', 3)
    u = world.user('u')
    codes = [u.post('/api/session').status_code for _ in range(4)]
    assert codes == [201, 201, 201, 429]


def test_runs_are_limited_per_session_even_from_new_addresses(world, monkeypatch):
    monkeypatch.setitem(AUTH, 'per_session_runs_per_hour', 2)
    monkeypatch.setitem(CFG['modes']['scripted'], 'per_client_runs_per_hour', 100)
    alice = world.user('alice').guest()
    clients = iter(['10.0.0.1', '10.0.0.2', '10.0.0.3'])
    monkeypatch.setattr(svc_mod, 'client_id', lambda request: next(clients))
    codes = [alice.post('/api/runs', json=SCRIPTED).status_code for _ in range(3)]
    assert codes == [202, 202, 429]


def test_sign_in_attempts_are_limited_per_client(world, monkeypatch):
    monkeypatch.setitem(ACC, 'auth_attempts_per_client_per_hour', 4)
    u = world.user('u')
    codes = [u.post('/api/auth/login', json={'email': 'x@example.invalid', 'password': 'whatever whatever'}).status_code for _ in range(5)]
    assert codes[:4] == [401] * 4 and codes[4] == 429


def test_verified_accounts_get_higher_run_quotas(world, monkeypatch):
    monkeypatch.setitem(CFG['modes']['scripted'], 'per_client_runs_per_hour', 1)
    guest = world.user('guest').guest()
    assert [guest.post('/api/runs', json=SCRIPTED).status_code for _ in range(2)] == [202, 429]
    world.service.hits.clear()
    acct = world.account('ivy', 'ivy@example.invalid')
    codes = [acct.post('/api/runs', json=SCRIPTED).status_code for _ in range(ACC['verified_quota_multiplier'] + 1)]
    assert codes == [202] * ACC['verified_quota_multiplier'] + [429]


def test_security_headers_no_store_and_size_limit(world):
    u = world.user('u')
    r = u.get('/api/catalog')
    for name, value in CFG['security_headers'].items():
        assert r.headers.get(name) == value
    assert r.headers['cache-control'] == 'no-store'
    assert u.post('/api/session', content=b'x' * (CFG['max_request_bytes'] + 1), headers={'content-length': str(CFG['max_request_bytes'] + 1)}).status_code == 413


def test_pages_are_revalidated_and_hashed_assets_kept(world):
    # A browser must never keep an old page (with its old security policy) pointing at assets from an earlier build.
    u = world.user('u')
    assert u.get('/').headers['cache-control'] == 'no-cache'
    assert u.get('/how').headers['cache-control'] == 'no-cache'
    assert u.get('/assets/index-0000.js').headers['cache-control'] == 'public, max-age=31536000, immutable'


def test_unauthenticated_account_actions_fail(world):
    u = world.user('u')
    assert u.get('/api/auth/me').status_code == 401
    assert u.post('/api/auth/password/change', json={'current_password': 'a' * 12, 'new_password': 'b' * 12}).status_code == 401
    assert u.request('DELETE', '/api/auth/account', json={'password': 'a' * 12}).status_code == 401
    assert u.post('/api/auth/verify', json={'token': 'forged'}).status_code == 400
    assert u.post('/api/auth/password/reset', json={'token': 'forged', 'password': 'a long new pass 1'}).status_code == 400
