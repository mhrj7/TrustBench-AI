"""Live-test service: modes, limits, holdout exclusion and key handling. Scripted runs execute the real runner."""
import json, os, sys, time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ['TRUSTBENCH_SERVICE_NO_AUTOSTART'] = '1'
from src.service import app as svc_mod  # noqa: E402
from src.service.app import CFG, RunRequest, Service, create_app  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
VISITOR_KEY = 'visitor-test-key-0123456789abcdef'


def wait(client, job_id, timeout=240):
    t = time.time()
    while time.time() - t < timeout:
        s = client.get(f'/api/runs/{job_id}').json()
        if s['status'] not in ('queued', 'running'):
            return s
        time.sleep(0.5)
    raise AssertionError('run did not finish')


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(Service(data_dir=tmp_path)))


def test_catalog_offers_every_mode_and_never_a_sealed_case(client):
    c = client.get('/api/catalog').json()
    assert set(c['modes']) == {'scripted', 'hosted', 'own_key'}
    sealed = set(json.loads((ROOT / 'data/splits.json').read_text())['holdout_manifest']['fixture_ids'])
    suite = {x['case_id']: x for x in json.loads((ROOT / CFG['suite']).read_text())['cases']}
    for case in c['cases']:
        assert suite[case['id']]['fixture_id'].split('--')[0] not in sealed
    assert 'api_key' not in json.dumps(c) and 'nvapi' not in json.dumps(c)
    assert c['agents']['trustbench_baseline']['status'] == 'available'


def test_scripted_run_end_to_end_with_report_evaluation_and_spans(client):
    r = client.post('/api/runs', json={'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['doc-benign', 'doc-attack']})
    assert r.status_code == 202
    s = wait(client, r.json()['id'])
    assert s['status'] == 'done' and s['summary']['valid_pairs'] == 2 and s['key_source'] is None
    report = client.get(f"/api/runs/{s['id']}/report").json()
    assert report['schema_version'] == '1.1.0' and len(report['cases']) == 2
    ev = client.get(f"/api/runs/{s['id']}/evaluation").json()
    assert ev['metrics']['defended']['rates']['unsafe_committed_effect']['denominator'] == 1
    assert client.get(f"/api/runs/{s['id']}/spans").json()


def test_requests_outside_the_offer_are_rejected(client):
    bad = [
        {'mode': 'scripted', 'system': 'gateway_directive_flow_v4'},  # model-based defense needs a live mode
        {'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['holdout-tb-ben-doc-005']},  # sealed / unknown
        {'mode': 'scripted', 'system': 'gateway_capability', 'repetitions': 9},
        {'mode': 'hosted', 'system': 'gateway_capability', 'model': 'nvidia:openai/gpt-oss-20b'},  # 16 cases > hosted cap
        {'mode': 'own_key', 'system': 'gateway_capability', 'model': 'nvidia:openai/gpt-oss-20b', 'cases': ['doc-benign']},  # no key
        {'mode': 'own_key', 'system': 'gateway_capability', 'model': 'ollama:qwen3.5:9b', 'cases': ['doc-benign'], 'api_key': VISITOR_KEY},
        {'mode': 'scripted', 'system': 'gateway_capability', 'agent': 'langgraph_http'},  # planned, not available yet
        {'mode': 'scripted', 'system': 'gateway_capability', 'api_key': VISITOR_KEY},
    ]
    for body in bad:
        r = client.post('/api/runs', json=body)
        assert 400 <= r.status_code < 600 and r.status_code != 202, body
        assert VISITOR_KEY not in r.text


def test_rate_limit_per_client(tmp_path, monkeypatch):
    monkeypatch.setitem(CFG['modes']['scripted'], 'per_client_runs_per_hour', 2)
    svc = Service(data_dir=tmp_path, start_workers=False)
    req = RunRequest(mode='scripted', system='gateway_capability', cases=['doc-benign'])
    svc.submit(req, 'a'); svc.submit(req, 'a')
    with pytest.raises(Exception) as e:
        svc.submit(req, 'a')
    assert '429' in repr(e.value) or 'rate limit' in str(e.value.detail)
    svc.submit(req, 'b')  # another client is unaffected


def test_hosted_budget_is_reserved_at_submission(tmp_path, monkeypatch):
    monkeypatch.setitem(CFG['modes']['hosted'], 'daily_pair_budget', 3)
    monkeypatch.setattr(svc_mod, 'env_value', lambda name: 'server-key-not-real-0000' if name else None)
    svc = Service(data_dir=tmp_path, start_workers=False)
    req = RunRequest(mode='hosted', system='gateway_capability', model='nvidia:openai/gpt-oss-20b', cases=['doc-benign', 'doc-attack'])
    svc.submit(req, 'a')
    assert svc.hosted_state()['remaining_pairs_today'] == 1
    with pytest.raises(Exception) as e:
        svc.submit(RunRequest(mode='hosted', system='gateway_capability', model='nvidia:openai/gpt-oss-20b', cases=['doc-benign', 'doc-attack']), 'b')
    assert e.value.status_code == 429


def test_own_key_is_passed_only_to_its_run_and_never_persisted(tmp_path, monkeypatch):
    monkeypatch.setattr(svc_mod, 'env_value', lambda name: 'server-key-not-real-0000' if name else None)
    svc = Service(data_dir=tmp_path, start_workers=False)
    job = svc.submit(RunRequest(mode='own_key', system='gateway_capability', model='nvidia:openai/gpt-oss-20b', cases=['doc-benign'], api_key=VISITOR_KEY), 'a')
    args, env = svc.command(svc.jobs[job['id']])
    assert env['NVIDIA_API_KEY'] == VISITOR_KEY and env['TRUSTBENCH_NO_DOTENV'] == '1'
    assert VISITOR_KEY not in ' '.join(args)
    for f in tmp_path.rglob('*'):
        if f.is_file():
            assert VISITOR_KEY not in f.read_text(errors='ignore')
    assert VISITOR_KEY not in json.dumps(svc.public(job['id']))
    hosted = svc.submit(RunRequest(mode='hosted', system='gateway_capability', model='nvidia:openai/gpt-oss-20b', cases=['doc-benign']), 'b')
    assert svc.command(svc.jobs[hosted['id']])[1]['NVIDIA_API_KEY'] == 'server-key-not-real-0000'
    scripted = svc.submit(RunRequest(mode='scripted', system='gateway_capability', cases=['doc-benign']), 'c')
    assert 'NVIDIA_API_KEY' not in svc.command(svc.jobs[scripted['id']])[1]


def test_a_key_that_reaches_run_output_deletes_the_artifacts(tmp_path):
    leak = tmp_path / 'leaky.py'
    leak.write_text("import os,sys,json,pathlib\nout=pathlib.Path(sys.argv[sys.argv.index('--out-dir')+1]); out.mkdir(parents=True,exist_ok=True)\n"
                    "(out/'report.json').write_text(json.dumps({'leak': os.environ.get('NVIDIA_API_KEY')}))\n")
    svc = Service(data_dir=tmp_path / 'data', runner=[sys.executable, str(leak)])
    c = TestClient(create_app(svc))
    r = c.post('/api/runs', json={'mode': 'own_key', 'system': 'gateway_capability', 'model': 'nvidia:openai/gpt-oss-20b', 'cases': ['doc-benign'], 'api_key': VISITOR_KEY})
    s = wait(c, r.json()['id'])
    assert s['status'] == 'failed' and 'key appeared' in s['error']
    assert not (tmp_path / 'data' / 'jobs' / s['id'] / 'out').exists()
    assert c.get(f"/api/runs/{s['id']}/report").status_code == 404


def test_access_token_when_the_deployment_sets_one(client, monkeypatch):
    monkeypatch.setenv(CFG['access_token_env'], 'demo-token-123')
    body = {'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['doc-benign']}
    assert client.post('/api/runs', json=body).status_code == 401
    assert client.post('/api/runs', json=body, headers={'X-TrustBench-Token': 'demo-token-123'}).status_code == 202


def test_invalid_runs_are_explained_in_plain_words():
    detail = [{'baseline_invalid': True, 'defended_invalid': True, 'baseline_failures': ['authentication'], 'defended_failures': ['authentication']},
              {'baseline_invalid': False, 'defended_invalid': True, 'baseline_failures': [], 'defended_failures': ['rate_limit']}]
    reasons = Service._reasons(detail)
    assert reasons[0] == {'code': 'authentication', 'runs': 2, 'message': CFG['invalid_reason_messages']['authentication']}
    assert reasons[1]['code'] == 'rate_limit' and reasons[1]['runs'] == 1


def test_run_ids_are_unguessable_and_safe_as_cli_arguments(tmp_path):
    svc = Service(data_dir=tmp_path, start_workers=False)
    ids = [svc.submit(RunRequest(mode='scripted', system='gateway_capability', cases=['doc-benign']), f'c{i}')['id'] for i in range(20)]
    assert all(len(i) == 24 and not i.startswith('-') for i in ids) and len(set(ids)) == 20
