"""TB-063: the host approval workflow's after-commit fault hook (src/policy/approved_call.py). The gateway's 409 pause
commits nothing and is not counted; the first committing response is the one that is lost; the counts persist across
the separate processes each approval runs in."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from src.policy import approved_call  # noqa: E402


def state(tmp_path, rules):
    p = tmp_path / 'faults.json'
    p.write_text(json.dumps({'rules': rules, 'attempts': {}, 'injected': []}))
    return p


def test_off_without_the_environment(monkeypatch):
    monkeypatch.delenv('TRUSTBENCH_COMMIT_FAULTS', raising=False)
    assert approved_call.commit_fault('apply_record_update') is None


def test_faults_only_the_scheduled_committing_attempt(monkeypatch, tmp_path):
    p = state(tmp_path, [{'tool': 'apply_record_update', 'attempts': [1], 'mode': 'fail_after', 'http_status': 503}])
    monkeypatch.setenv('TRUSTBENCH_COMMIT_FAULTS', str(p))
    assert approved_call.commit_fault('apply_record_update')['mode'] == 'fail_after'
    assert approved_call.commit_fault('apply_record_update') is None, 'the retry is not faulted again'
    s = json.loads(p.read_text())
    assert s['attempts'] == {'apply_record_update': 2}
    assert s['injected'] == [{'tool': 'apply_record_update', 'attempt': 1, 'mode': 'fail_after', 'path': 'approved_call'}]


def test_only_after_commit_modes_are_accepted(monkeypatch, tmp_path):
    monkeypatch.setenv('TRUSTBENCH_COMMIT_FAULTS', str(state(tmp_path, [{'tool': 'apply_record_update', 'attempts': [1], 'mode': 'hang'}])))
    with pytest.raises(SystemExit):
        approved_call.commit_fault('apply_record_update')


def test_the_pause_is_not_counted():
    src = (ROOT / 'src/policy/approved_call.py').read_text()
    assert 'commit_fault(tool) if response.status_code != 409 else None' in src
