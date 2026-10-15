#!/usr/bin/env python3
"""Per-call latency of the gateway path versus the direct tool service, in-process (configs/benchmarks.yaml).

Measures the gateway's own processing (session check, capability and argument policy, optional flow check, provenance
envelope, nested ASGI dispatch). HTTP server and model latency are excluded. Writes evidence/gateway-overhead-report.json.
"""
import json, os, statistics, sys, tempfile, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
cfg = json.loads((ROOT / 'configs/benchmarks.yaml').read_text())['gateway_overhead']
run_cfg = json.loads((ROOT / 'configs/live-run.yaml').read_text())

with tempfile.TemporaryDirectory() as tmp:
    from src.arms.fixtures import materialize, write_jsonl
    write_jsonl(Path(tmp) / 'f.jsonl', materialize()[0])
    os.environ.update(TRUSTBENCH_FIXTURE_PATH=str(Path(tmp) / 'f.jsonl'), TRUSTBENCH_TOOL_DB=str(Path(tmp) / 's.sqlite'), TRUSTBENCH_TOOL_MODE='permissive')
    from fastapi.testclient import TestClient
    from src.tools.app import app, store
    from src.gateway.app import Gateway
    cap = run_cfg['episode_max_tool_calls']
    allowed = store.fixtures[cfg['fixture_id']]['task_contract']['allowed_tools']

    def series(make_client):
        times = []
        total = cfg['warmup_calls'] + cfg['measured_calls']
        while len(times) < total:
            store.reset('bench', cfg['fixture_id'], cap)
            post = make_client()
            for _ in range(min(cap, total - len(times))):
                t0 = time.perf_counter()
                response = post()
                elapsed = (time.perf_counter() - t0) * 1000
                assert response.status_code == 200, response.text
                times.append(elapsed)
        sample = sorted(times[cfg['warmup_calls']:])
        q = lambda p: round(sample[min(len(sample) - 1, int(p * len(sample)))], 4)
        return {'n': len(sample), 'p50_ms': q(0.5), 'p95_ms': q(0.95), 'mean_ms': round(statistics.fmean(sample), 4)}

    direct_client = TestClient(app)
    url = f"/v1/episodes/bench/tools/{cfg['tool']}"
    results = {'direct_tool_service': series(lambda: (lambda: direct_client.post(url, json=cfg['arguments'])))}
    for name, flow in (('gateway_capability_only', False), ('gateway_capability_plus_flow', True)):
        def make(flow=flow):
            gateway = Gateway(app, flow_check=flow)
            token = gateway.bind('bench', allowed)
            client = TestClient(gateway.app)
            return lambda: client.post(url, headers={'Authorization': 'Bearer ' + token}, json=cfg['arguments'])
        results[name] = series(make)
    base = results['direct_tool_service']
    for name in ('gateway_capability_only', 'gateway_capability_plus_flow'):
        results[name]['added_p50_ms'] = round(results[name]['p50_ms'] - base['p50_ms'], 4)
        results[name]['added_p95_ms'] = round(results[name]['p95_ms'] - base['p95_ms'], 4)

report = {'schema_version': '1.0.0', 'metric': 'TB-M6 component (gateway per-call overhead)', 'checked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
          'config': cfg, 'machine': os.uname().machine, 'results': results,
          'limitations': ['In-process ASGI test client; real HTTP and network add their own latency.', 'One read tool on one fixture; write paths and approval pauses are not timed.', 'End-to-end run latency is dominated by model calls and is reported separately in the live-run reports.']}
(ROOT / 'evidence/gateway-overhead-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(results))
