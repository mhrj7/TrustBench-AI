"""Human approval mode: decisions are explicit, bound to the exact arguments, and absent decisions reject."""
import copy, importlib, json, sys, threading, time
import pytest
from src.policy import approved_call


@pytest.fixture
def queue(tmp_path, monkeypatch):
    policy = copy.deepcopy(approved_call.POLICY)
    policy['human_approval'] = {**policy['human_approval'], 'queue_dir': str(tmp_path), 'poll_interval_ms': 10, 'wait_timeout_s': 2}
    return tmp_path, policy

PAYLOAD = {'request_id': 'req-1', 'tool': 'apply_record_update', 'arguments': {'record_id': 'r', 'value': 'SMS'}}
FIXTURE = {'task_contract': {'user_id': 'u', 'request': 'update once'}}


def decide_later(path, decision, delay=0.05):
    def write():
        time.sleep(delay)
        (path / 'decisions').mkdir(parents=True, exist_ok=True)
        (path / 'decisions' / 'req-1.json').write_text(json.dumps(decision))
    threading.Thread(target=write).start()


def test_operator_approval_of_the_exact_arguments_is_accepted_and_the_queue_entry_is_removed(queue):
    path, policy = queue
    decide_later(path, {'approved': True, 'arguments': PAYLOAD['arguments']})
    assert approved_call.human_decision(PAYLOAD, FIXTURE, policy) is True
    assert not list((path / 'pending').glob('*.json'))


def test_approval_for_different_arguments_is_a_rejection(queue):
    path, policy = queue
    decide_later(path, {'approved': True, 'arguments': {'record_id': 'other', 'value': 'SMS'}})
    assert approved_call.human_decision(PAYLOAD, FIXTURE, policy) is False


def test_explicit_rejection_and_silence_both_reject(queue):
    path, policy = queue
    decide_later(path, {'approved': False, 'arguments': PAYLOAD['arguments']})
    assert approved_call.human_decision(PAYLOAD, FIXTURE, policy) is False
    t = [0.0]
    assert approved_call.human_decision({**PAYLOAD, 'request_id': 'req-2'}, FIXTURE, policy, clock=lambda: t.__setitem__(0, t[0] + 1) or t[0]) is False


def test_pending_entry_shows_the_exact_arguments_to_the_operator(queue):
    path, policy = queue
    seen = {}
    def inspect():
        for _ in range(100):
            files = list((path / 'pending').glob('*.json'))
            if files:
                seen.update(json.loads(files[0].read_text()))
                (path / 'decisions').mkdir(parents=True, exist_ok=True)
                (path / 'decisions' / 'req-1.json').write_text(json.dumps({'approved': True, 'arguments': seen['arguments']}))
                return
            time.sleep(0.01)
    threading.Thread(target=inspect).start()
    assert approved_call.human_decision(PAYLOAD, FIXTURE, policy) is True
    assert seen['arguments'] == PAYLOAD['arguments'] and seen['task'] == 'update once'
