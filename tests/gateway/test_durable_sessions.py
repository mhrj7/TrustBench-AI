"""TB-026: gateway sessions survive a restart through a hashed, expiring session store."""
import importlib, os, stat, sys, sqlite3, time
import pytest
from fastapi.testclient import TestClient
from src.gateway.app import Gateway


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setenv('TRUSTBENCH_TOOL_DB', str(tmp_path / 'tools.sqlite'))
    sys.modules.pop('src.tools.app', None)
    module = importlib.import_module('src.tools.app')
    module.store.reset('doc', 'TB-BEN-DOC-001', 12)
    return module, tmp_path


def read(gateway, token):
    return TestClient(gateway.app).post('/v1/episodes/doc/tools/read_document', headers={'Authorization': 'Bearer ' + token}, json={'resource_id': 'doc-cedar-policy'})


def test_a_restarted_gateway_accepts_the_same_session_with_the_same_signing_key(backend):
    module, tmp = backend
    db = str(tmp / 'sessions.sqlite')
    first = Gateway(module.app, session_db=db, session_ttl_s=60)
    token = first.bind('doc', ['read_document'])
    key = first.signing_key(token)
    restarted = Gateway(module.app, session_db=db, session_ttl_s=60)
    response = read(restarted, token)
    assert response.status_code == 200
    assert restarted.signing_key(token) == key
    assert stat.S_IMODE(os.stat(db).st_mode) == 0o600
    with sqlite3.connect(db) as c:
        assert token not in str(c.execute('SELECT * FROM gateway_sessions').fetchall()), 'only a hash of the bearer token is stored'


def test_without_a_store_a_restart_loses_the_session(backend):
    module, _ = backend
    token = Gateway(module.app).bind('doc', ['read_document'])
    assert read(Gateway(module.app), token).status_code == 403


def test_expired_and_revoked_sessions_do_not_survive(backend):
    module, tmp = backend
    db = str(tmp / 's.sqlite')
    g = Gateway(module.app, session_db=db, session_ttl_s=60)
    token = g.bind('doc', ['read_document'])
    g.revoke(token)
    assert read(Gateway(module.app, session_db=db, session_ttl_s=60), token).status_code == 403
    expired = Gateway(module.app, session_db=db, session_ttl_s=-1)
    t2 = expired.bind('doc', ['read_document'])
    assert read(Gateway(module.app, session_db=db, session_ttl_s=60), t2).status_code == 403


def test_a_restored_session_still_enforces_its_capability_and_reset_generation(backend):
    module, tmp = backend
    db = str(tmp / 's.sqlite')
    token = Gateway(module.app, session_db=db, session_ttl_s=60).bind('doc', ['read_document'])
    restarted = Gateway(module.app, session_db=db, session_ttl_s=60)
    client = TestClient(restarted.app)
    assert client.post('/v1/episodes/doc/tools/read_document', headers={'Authorization': 'Bearer ' + token}, json={'resource_id': 'doc-other'}).status_code == 403
    module.store.reset('doc', 'TB-BEN-DOC-001', 12)
    assert read(restarted, token).status_code == 403, 'a reset after the restart still invalidates the old capability'
