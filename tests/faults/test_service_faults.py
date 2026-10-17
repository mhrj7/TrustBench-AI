"""TB-040 drills at the live-test service: cancelling a run mid-flight, storage that cannot be written, and a damaged shared
budget record. Each must give an explicit status, leave no process or effect behind, and fail closed."""
import json, os, subprocess, time
from pathlib import Path

import pytest

os.environ['TRUSTBENCH_SERVICE_NO_AUTOSTART'] = '1'
from src.service import app as svc_mod  # noqa: E402
from src.service.app import CFG, RunRequest, Service  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def measure(name: str, values: dict):
    """Drill measurements for scripts/fault-drill.py (reports/fault-drill.md)."""
    d = ROOT / '.tool-state' / 'faults'
    d.mkdir(parents=True, exist_ok=True)
    (d / f'{name}.json').write_text(json.dumps(values))


def group_members(pgid: int) -> list[int]:
    out = subprocess.run(['ps', '-A', '-o', 'pid=,pgid=,stat='], capture_output=True, text=True).stdout
    return [int(pid) for pid, g, stat in (l.split()[:3] for l in out.splitlines() if l.strip()) if int(g) == pgid and not stat.startswith('Z')]


def test_deleting_a_running_run_stops_the_runner_and_every_service_it_started(tmp_path):
    svc = Service(data_dir=tmp_path)
    cases = [c['id'] for c in svc.catalog()['cases']][:CFG['modes']['scripted']['max_pairs_per_run']]
    job = svc.submit(RunRequest(mode='scripted', system='gateway_capability', cases=cases, repetitions=2), 'drill', 'owner')
    deadline, members = time.time() + 120, []
    while time.time() < deadline:  # wait until the runner has started its own child services
        proc = svc.procs.get(job['id'])
        if proc and len(members := group_members(os.getpgid(proc.pid))) >= 2:
            break
        time.sleep(0.2)
    assert len(members) >= 2, 'the runner did not start child processes in time'
    pgid = os.getpgid(proc.pid)
    t = time.time()
    removed = svc.delete(job['id'], 'owner')
    stop_s = time.time() - t
    assert removed['deleted'] == job['id']
    assert group_members(pgid) == [], 'no process of the cancelled run survives'
    assert not (tmp_path / 'jobs' / job['id']).exists(), 'every artifact of the cancelled run is gone'
    assert job['id'] not in svc.jobs
    time.sleep(1)
    assert not (tmp_path / 'jobs' / job['id']).exists(), 'the worker does not re-create the deleted run when its process exits'
    assert stop_s < 25
    measure('cancel', {'processes_in_run_group_before': len(members), 'processes_after': 0, 'stop_seconds': round(stop_s, 2)})


def test_unwritable_storage_refuses_new_runs_explicitly_and_reserves_no_budget(tmp_path, monkeypatch):
    monkeypatch.setattr(svc_mod, 'env_value', lambda name: 'server-key-not-real-0000' if name else None)
    svc = Service(data_dir=tmp_path, start_workers=False)
    before = svc.hosted_state()['remaining_pairs_today']
    jobs = tmp_path / 'jobs'
    jobs.mkdir(exist_ok=True)
    os.chmod(jobs, 0o500)
    try:
        if os.access(jobs, os.W_OK):
            pytest.skip('running as a user that ignores directory permissions')
        with pytest.raises(Exception) as e:
            svc.submit(RunRequest(mode='hosted', system='gateway_capability', model='nvidia:openai/gpt-oss-20b', cases=['doc-benign']), 'a', 'o1')
    finally:
        os.chmod(jobs, 0o700)
    assert e.value.status_code == 503 and 'storage_unavailable' in e.value.detail
    assert svc.hosted_state()['remaining_pairs_today'] == before, 'a refused run reserves none of the shared budget'
    assert svc.jobs == {}
    svc.submit(RunRequest(mode='scripted', system='gateway_capability', cases=['doc-benign']), 'a', 'o1')  # recovers once writable


def test_a_damaged_budget_record_pauses_the_shared_key_instead_of_resetting_it(tmp_path, monkeypatch):
    monkeypatch.setattr(svc_mod, 'env_value', lambda name: 'server-key-not-real-0000' if name else None)
    svc = Service(data_dir=tmp_path, start_workers=False)
    (tmp_path / CFG['modes']['hosted']['budget_file']).write_text('{"date": "2026-10-17", "pairs": ')  # torn write
    state = svc.hosted_state()
    assert state['available'] is False and state['remaining_pairs_today'] == 0 and 'cannot be read' in state['reason']
    with pytest.raises(Exception) as e:
        svc.submit(RunRequest(mode='hosted', system='gateway_capability', model='nvidia:openai/gpt-oss-20b', cases=['doc-benign']), 'a', 'o1')
    assert e.value.status_code == 429
    # the other ways in stay open: scripted runs need no key or budget
    svc.submit(RunRequest(mode='scripted', system='gateway_capability', cases=['doc-benign']), 'a', 'o1')


def test_a_runner_that_ignores_sigterm_is_killed_with_its_children(tmp_path):
    """The real runner stops its services on SIGTERM (the drill above passes either way). This covers a runner that hangs or
    ignores SIGTERM: killing only the runner would orphan its children; stopping the process group does not."""
    script = ("import signal, subprocess, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
              "subprocess.Popen([sys.executable, '-c', 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)']); time.sleep(600)")
    proc = subprocess.Popen([os.sys.executable, '-c', script], start_new_session=True)
    pgid = os.getpgid(proc.pid)
    deadline = time.time() + 10
    while len(group_members(pgid)) < 2 and time.time() < deadline:
        time.sleep(0.1)
    assert len(group_members(pgid)) == 2
    svc_mod.stop_group(proc, grace_s=1)
    assert group_members(pgid) == []


def test_a_read_only_data_volume_degrades_the_service_instead_of_stopping_it(tmp_path):
    """The whole data volume is read-only (a failed or full disk): the service still starts and serves the catalog and the
    published results; sessions and runs answer 503 storage_unavailable, and every mode reports why it is unavailable."""
    from fastapi.testclient import TestClient
    from src.service.app import create_app
    data = tmp_path / 'ro'
    data.mkdir()
    os.chmod(data, 0o500)
    try:
        if os.access(data, os.W_OK):
            pytest.skip('running as a user that ignores directory permissions')
        svc = Service(data_dir=data)
        client = TestClient(create_app(svc))
        cat = client.get('/api/catalog')
        health = client.get('/api/health').json()
        session = client.post('/api/session')
        run = client.post('/api/runs', json={'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['doc-benign']})
    finally:
        os.chmod(data, 0o700)
    assert svc.storage_error and cat.status_code == 200 and cat.json()['storage'] == 'unavailable'
    assert all(not m['available'] and m['reason'] == CFG['storage_unavailable_reason'] for m in cat.json()['modes'].values())
    assert health == {'ok': False, 'storage': 'unavailable', 'jobs': 0}
    assert session.status_code == 503 and run.status_code == 503 and 'storage_unavailable' in run.json()['detail']
    measure('read-only-volume', {'catalog': cat.status_code, 'session': session.status_code, 'run': run.status_code})
