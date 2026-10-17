"""TB-037: the trustbench CLI. Fast commands only; smoke --check and the live benchmark are exercised by the fresh-environment
reproduction (evidence/tb037-fresh-reproduction.json)."""
import copy, json
from pathlib import Path

from typer.testing import CliRunner

from src import cli

ROOT = Path(__file__).resolve().parents[2]
runner = CliRunner()
GATE_REPORT = ROOT / json.loads((ROOT / 'evidence/release-gate-dev.json').read_text())['report']


def test_help_lists_every_command():
    out = runner.invoke(cli.app, ['--help']).output
    for command in ('validate', 'fetch-data', 'smoke', 'benchmark', 'evaluate', 'report', 'manifest'):
        assert command in out


def test_manifest_matches_the_committed_pins_and_detects_a_change(monkeypatch):
    assert runner.invoke(cli.app, ['manifest']).exit_code == 0
    real = cli.digests
    monkeypatch.setattr(cli, 'digests', lambda: {**real(), 'data/benign.jsonl': '0' * 64})
    r = runner.invoke(cli.app, ['manifest'])
    assert r.exit_code == 1 and 'data/benign.jsonl' in r.output


def test_report_schema_accepts_real_reports_and_rejects_a_broken_one():
    report = json.loads(GATE_REPORT.read_text())
    assert cli.schema_errors(report, cli.CFG['report_schema']) == []
    broken = copy.deepcopy(report)
    del broken['cases'][0]['defended']['evaluation']['security_pass']
    broken['schema_version'] = '9.9.9'
    errors = cli.schema_errors(broken, cli.CFG['report_schema'])
    assert any('security_pass' in e for e in errors) and any('schema_version' in e for e in errors)


def test_volatile_keys_are_ignored_and_nothing_else():
    a = {'checked_at': 'x', 'cases': [{'elapsed_ms': 1, 'outcome': 'success'}]}
    b = {'checked_at': 'y', 'cases': [{'elapsed_ms': 2, 'outcome': 'success'}]}
    c = {'checked_at': 'y', 'cases': [{'elapsed_ms': 2, 'outcome': 'failure'}]}
    v = {'checked_at', 'elapsed_ms'}
    assert cli.normalise(a, v) == cli.normalise(b, v) != cli.normalise(c, v)


def test_benchmark_profiles_build_the_runner_command():
    frozen = json.loads(runner.invoke(cli.app, ['benchmark', 'dev-frozen', '--dry-run']).output)
    hc = json.loads((ROOT / 'configs/frozen/holdout-config.json').read_text())
    cmd = frozen['command']
    assert cmd[cmd.index('--model') + 1] == hc['model'] and cmd[cmd.index('--defended-system') + 1] == hc['defended_system']['system']
    assert '--reliability' in cmd and frozen['credential_env'] == hc['provider_entry']['api_key_env']
    local = json.loads(runner.invoke(cli.app, ['benchmark', 'dev-local-ollama', '--dry-run']).output)
    assert local['credential_env'] is None and '--reliability' not in local['command']


def test_missing_credentials_are_reported_without_reading_values(monkeypatch):
    monkeypatch.delenv('TRUSTBENCH_TEST_ABSENT_KEY', raising=False)
    assert cli.key_available(None) and not cli.key_available('TRUSTBENCH_TEST_ABSENT_KEY')
    monkeypatch.setenv('TRUSTBENCH_TEST_ABSENT_KEY', 'x')
    assert cli.key_available('TRUSTBENCH_TEST_ABSENT_KEY')


def test_evaluate_reports_metrics_and_intervals(tmp_path):
    out = tmp_path / 'e.json'
    r = runner.invoke(cli.app, ['evaluate', str(GATE_REPORT), '--out', str(out)])
    assert r.exit_code == 0
    result = json.loads(out.read_text())
    gate = json.loads((ROOT / 'evidence/release-gate-dev.json').read_text())
    assert result['uncertainty']['endpoints']['unsafe_committed_effect']['paired_difference']['point'] == gate['tolerances']['T1_unsafe_committed_effect']['point']


def test_remote_run_against_the_service_api(tmp_path, monkeypatch):
    """`trustbench remote` drives the same API as the website (here in-process, a scripted run)."""
    import os
    from urllib.parse import urlparse
    os.environ['TRUSTBENCH_SERVICE_NO_AUTOSTART'] = '1'
    from fastapi.testclient import TestClient
    from src.service.app import Service, create_app
    api = TestClient(create_app(Service(data_dir=tmp_path)))
    session = api.post('/api/session').json()['token']

    def http(method, url, body=None, token=None, headers=None):
        r = api.request(method, urlparse(url).path, json=body, headers={'Authorization': f'Bearer {session}', **(headers or {})})
        assert r.status_code < 400, r.text
        return r.json()
    monkeypatch.setattr(cli, 'http', http)
    r = runner.invoke(cli.app, ['remote', 'run', '--url', 'http://svc', '--mode', 'scripted', '--cases', 'doc-benign,doc-attack', '--wait'])
    assert r.exit_code == 0, r.output
    run_id = json.loads(r.output.split('\n}\n')[0] + '\n}')['id']
    out = tmp_path / 'r.json'
    assert runner.invoke(cli.app, ['remote', 'report', run_id, '--url', 'http://svc', '--out', str(out)]).exit_code == 0
    assert len(json.loads(out.read_text())['cases']) == 2


def test_remote_own_key_reads_the_key_from_an_environment_variable_only(monkeypatch):
    r = runner.invoke(cli.app, ['remote', 'run', '--url', 'http://svc', '--mode', 'own_key', '--model', 'nvidia:openai/gpt-oss-20b'])
    assert r.exit_code == 2 and '--key-env' in r.output
