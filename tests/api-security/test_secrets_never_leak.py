"""TB-039 acceptance: project and visitor keys, passwords and tokens never appear in storage, logs, responses or artifacts."""
import logging, sys, time

from conftest import PASSWORD

import src.service.app as svc_mod
from src.service import secrets as sec

VISITOR_KEY = 'visitor-key-for-security-tests-0123456789'
PROJECT_KEY = 'project-key-for-security-tests-9876543210'


def all_bytes(world) -> str:
    return '\n'.join(p.read_text(errors='ignore') for p in world.files())


def test_visitor_and_project_keys_never_reach_storage_responses_or_artifacts(world, monkeypatch):
    monkeypatch.setenv('NVIDIA_API_KEY', PROJECT_KEY)
    alice = world.user('alice').guest()
    seen = []
    # A runner that echoes its environment into every output channel it has, to prove the service scrubs what it serves.
    fake = world.data.parent / 'echo_runner.py'
    fake.write_text("import os,sys,json,pathlib\nout=pathlib.Path(sys.argv[sys.argv.index('--out-dir')+1]); out.mkdir(parents=True,exist_ok=True)\n"
                    "sys.stderr.write('key='+os.environ.get('NVIDIA_API_KEY','')+'\\n')\n(out/'report.json').write_text(json.dumps({'k':os.environ.get('NVIDIA_API_KEY')}))\n")
    world.service.runner = [sys.executable, str(fake)]
    for mode, key in (('own_key', VISITOR_KEY), ('hosted', None)):
        body = {'mode': mode, 'system': 'gateway_capability', 'model': 'nvidia:openai/gpt-oss-20b', 'cases': ['doc-benign'], **({'api_key': key} if key else {})}
        r = alice.post('/api/runs', json=body)
        seen.append(r.text)
        job = r.json()
        while job['status'] in ('queued', 'running'):
            time.sleep(0.3)
            r = alice.get(f"/api/runs/{job['id']}")
            seen.append(r.text)
            job = r.json()
        assert job['status'] == 'failed' and 'key appeared' in job['error']
        seen.append(alice.get(f"/api/runs/{job['id']}/report").text)
    seen += [alice.get('/api/runs').text, alice.get('/api/catalog').text]
    stored = all_bytes(world)
    for secret in (VISITOR_KEY, PROJECT_KEY):
        assert secret not in stored, 'a key reached service storage'
        assert all(secret not in s for s in seen), 'a key reached a response'


def test_log_records_are_redacted(caplog):
    sec.remember(VISITOR_KEY)
    sec.install_log_redaction(['tb039-test'])
    log = logging.getLogger('tb039-test')
    with caplog.at_level(logging.INFO, logger='tb039-test'):
        log.info('provider rejected key %s', VISITOR_KEY)
    assert VISITOR_KEY not in caplog.text and sec.PLACEHOLDER in caplog.text
    sec.forget(VISITOR_KEY)


def test_passwords_and_session_tokens_are_stored_only_as_hashes(world):
    alice = world.account('alice', 'alice@example.invalid')
    token = alice.headers['Authorization'].split()[1]
    stored = '\n'.join(p.read_bytes().decode('latin-1') for p in world.files())
    assert PASSWORD not in stored and token not in stored
    row = world.service.accounts.by_email('alice@example.invalid')
    assert row['password_hash'].startswith('scrypt$') and PASSWORD not in row['password_hash']
    share = alice.post(f"/api/runs/{alice.run()['id']}/share").json()['share_token']
    assert share not in '\n'.join(p.read_text(errors='ignore') for p in world.files())


def test_secrets_manager_reads_mounted_secret_files(tmp_path, monkeypatch):
    f = tmp_path / 'nvidia_key'
    f.write_text(PROJECT_KEY + '\n')
    monkeypatch.delenv('TB039_TEST_SECRET', raising=False)
    monkeypatch.setenv('TB039_TEST_SECRET_FILE', str(f))
    assert sec.get('TB039_TEST_SECRET') == PROJECT_KEY
    monkeypatch.setattr(sec, 'MOUNT_DIR', tmp_path)
    monkeypatch.delenv('TB039_TEST_SECRET_FILE')
    (tmp_path / 'tb039_test_secret').write_text('from-mount-dir-secret')
    assert sec.get('TB039_TEST_SECRET') == 'from-mount-dir-secret'
