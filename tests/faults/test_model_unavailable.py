"""TB-040 drill: an unavailable model produces an explicit status, commits no effect, and never bypasses policy.

The real runner (scripts/run-arm-smoke.mjs, live mode) is pointed at a loopback stub through TRUSTBENCH_DRILL_MODEL_BASE_URL:
nothing listening (connection refused), a server that answers 503, and one that never answers. A dummy key goes only to
the stub; the runner is told not to read .env, so no real provider is ever called."""
import json, socket, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CASES = 'doc-attack,doc-benign'


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Stub(BaseHTTPRequestHandler):
    mode = '503'

    def do_POST(self):
        if self.mode == 'hang':
            time.sleep(120)
            return
        body = json.dumps({'error': {'message': 'drill: service unavailable'}}).encode()
        self.send_response(503)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def serve(mode: str):
    handler = type(f'Stub{mode}', (Stub,), {'mode': mode})
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run(tmp_path: Path, base_url: str, cases: str = CASES, timeout_ms: int | None = None) -> dict:
    rel = tmp_path / 'drill-reliability.json'
    rel.write_text(json.dumps({'name': 'fault-drill', 'retry': {'max_attempts_per_call': 1}, **({'timeout_ms': timeout_ms} if timeout_ms else {})}))
    out = tmp_path / 'out'
    env = {**dict(__import__('os').environ), 'NVIDIA_API_KEY': 'drill-dummy-key-not-real-000000', 'TRUSTBENCH_NO_DOTENV': '1', 'TRUSTBENCH_DRILL_MODEL_BASE_URL': base_url}
    p = subprocess.run(['node', '--experimental-strip-types', '--no-warnings', 'scripts/run-arm-smoke.mjs', '--model', 'nvidia:openai/gpt-oss-20b', '--defended-system', 'gateway_capability',
                        '--cases', cases, '--repetitions', '1', '--reliability', str(rel), '--out-dir', str(out), '--work-dir', str(tmp_path / 'work')],
                       cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    assert (out / 'report.json').exists(), p.stderr[-800:]
    return json.loads((out / 'report.json').read_text())


def assert_explicit_and_effect_free(report: dict, codes: set[str], outcome: str = 'failure'):
    assert report['fault_drill']['model_base_url'].startswith('http://127.0.0.1:')
    v = report['summary']['validity']
    assert v['invalid_pairs'] == v['total_pairs'] > 0  # every pair is explicitly invalid, never counted as secure or useful
    for case in report['cases']:
        for arm in ('baseline', 'defended'):
            side = case[arm]
            assert side['invalid'] and side['outcome'] == outcome
            assert set(side['failures']) & codes, side['failures']
            assert side['tool_calls'] == 0 and side['final_tool_calls'] == 0  # no tool ran, so nothing was committed
        assert not [d for d in case['defended']['policy_decisions'] if d['decision'] == 'allow']
        assert case['final_state_identical']


def test_model_endpoint_refusing_connections(tmp_path):
    report = run(tmp_path, f'http://127.0.0.1:{free_port()}/v1')
    assert_explicit_and_effect_free(report, {'network'})


def test_model_endpoint_failing_with_503(tmp_path):
    server = serve('503')
    try:
        report = run(tmp_path, f'http://127.0.0.1:{server.server_port}/v1')
    finally:
        server.shutdown()
    assert_explicit_and_effect_free(report, {'server'})


def test_model_endpoint_that_never_answers(tmp_path):
    server = serve('hang')
    try:
        t = time.time()
        # the run timeout (20 s) is far shorter than the stub's hang (120 s): the run must end at the timeout, attributed to the model
        report = run(tmp_path, f'http://127.0.0.1:{server.server_port}/v1', cases='doc-attack', timeout_ms=20_000)
        elapsed = time.time() - t
    finally:
        server.shutdown()
    assert_explicit_and_effect_free(report, {'timeout'}, outcome='timeout')
    d = ROOT / '.tool-state' / 'faults'
    d.mkdir(parents=True, exist_ok=True)
    (d / 'model-hang.json').write_text(json.dumps({'run_timeout_ms': 20_000, 'stub_hang_s': 120, 'pairs': len(report['cases']), 'elapsed_s': round(elapsed, 1),
                                                   'arm_elapsed_ms': [report['cases'][0][a]['elapsed_ms'] for a in ('baseline', 'defended')]}))
    assert elapsed < 110  # bounded by the run timeout (two arms), not by the hung server


def test_a_drill_url_must_be_loopback_and_is_refused_for_the_holdout(tmp_path):
    env = {**dict(__import__('os').environ), 'NVIDIA_API_KEY': 'x' * 20, 'TRUSTBENCH_NO_DOTENV': '1', 'TRUSTBENCH_DRILL_MODEL_BASE_URL': 'https://example.com/v1'}
    p = subprocess.run(['node', '--experimental-strip-types', '--no-warnings', 'scripts/run-arm-smoke.mjs', '--model', 'nvidia:openai/gpt-oss-20b', '--cases', 'doc-benign',
                        '--out-dir', str(tmp_path / 'o'), '--work-dir', str(tmp_path / 'w')], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    assert p.returncode != 0 and 'loopback' in p.stderr
