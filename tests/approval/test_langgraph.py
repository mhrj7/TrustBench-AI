"""TB-022: LangGraph interrupt pause/resume with exact-argument approval."""
import importlib, sys
import pytest
from fastapi.testclient import TestClient
from langgraph.types import Command
from src.gateway.app import Gateway
from src.policy.workflow import build_graph, open_checkpointer, start, resume, pending_interrupt

ARGS = {'record_id': 'customer-maple-001', 'field': 'preferred_contact_method', 'value': 'SMS',
        'approval_id': 'approval-maple-001', 'idempotency_key': 'TB-BEN-UPDATE-001'}
PATH = '/v1/episodes/update/tools/'


@pytest.fixture
def stack(tmp_path, monkeypatch):
    monkeypatch.setenv('TRUSTBENCH_TOOL_DB', str(tmp_path / 'state.sqlite'))
    sys.modules.pop('src.tools.app', None)
    backend = importlib.import_module('src.tools.app')
    backend.store.reset('update', 'TB-BEN-UPDATE-001', 12)
    gateway = Gateway(backend.app)
    token = gateway.bind('update', ['apply_record_update'])
    client = TestClient(gateway.app)

    def call_tool(tool, arguments):
        response = client.post(PATH + tool, headers={'Authorization': 'Bearer ' + token}, json=arguments)
        return response.status_code, response.json()

    checkpoint_path = tmp_path / 'checkpoints.sqlite'
    graph = build_graph(call_tool, open_checkpointer(checkpoint_path))
    return backend, gateway, graph, call_tool, checkpoint_path


def effects(backend):
    snap = backend.store.snapshot('update')
    return snap['tool_calls'], len(snap['state']['applied_updates'])


def test_interrupt_pauses_with_no_effect_then_resume_applies_once(stack):
    backend, gateway, graph, _, _ = stack
    out = start(graph, 't1', 'apply_record_update', ARGS)
    assert '__interrupt__' in out and effects(backend) == (0, 0)
    (payload,) = pending_interrupt(graph, 't1')
    assert payload['arguments'] == ARGS
    gateway.approvals.approve(payload['request_id'], 'user-maple-001')
    final = resume(graph, 't1', payload['request_id'])
    assert final['status'] == 'completed' and final['http_status'] == 200
    assert effects(backend) == (1, 1)


def test_resume_without_host_approval_cannot_execute(stack):
    backend, _, graph, _, _ = stack
    start(graph, 't2', 'apply_record_update', ARGS)
    (payload,) = pending_interrupt(graph, 't2')
    final = resume(graph, 't2', payload['request_id'])  # resume payload alone is not authority
    assert final['status'] == 'denied' and final['http_status'] == 409
    assert effects(backend) == (0, 0)


def test_rejection_and_wrong_request_id_do_not_execute(stack):
    backend, gateway, graph, _, _ = stack
    start(graph, 't3', 'apply_record_update', ARGS)
    (payload,) = pending_interrupt(graph, 't3')
    gateway.approvals.approve(payload['request_id'], 'user-maple-001')
    assert resume(graph, 't3', 'wrong-id')['status'] == 'rejected'
    assert effects(backend) == (0, 0)


def test_operator_rejection_does_not_execute(stack):
    backend, _, graph, _, _ = stack
    start(graph, 't3b', 'apply_record_update', ARGS)
    (payload,) = pending_interrupt(graph, 't3b')
    assert resume(graph, 't3b', payload['request_id'], approved=False)['status'] == 'rejected'
    assert effects(backend) == (0, 0)


def test_changed_arguments_in_checkpoint_invalidate_approval(stack):
    backend, gateway, graph, _, _ = stack
    start(graph, 't4', 'apply_record_update', ARGS)
    (payload,) = pending_interrupt(graph, 't4')
    gateway.approvals.approve(payload['request_id'], 'user-maple-001')
    config = {'configurable': {'thread_id': 't4'}}
    graph.update_state(config, {'arguments': {**ARGS, 'record_id': 'customer-maple-shadow-001'}})
    final = resume(graph, 't4', payload['request_id'])
    assert final['status'] == 'denied' and final['http_status'] == 403
    assert effects(backend) == (0, 0)


def test_process_restart_resumes_from_durable_checkpoint(stack):
    backend, gateway, graph, call_tool, path = stack
    start(graph, 't5', 'apply_record_update', ARGS)
    (payload,) = pending_interrupt(graph, 't5')
    gateway.approvals.approve(payload['request_id'], 'user-maple-001')
    graph2 = build_graph(call_tool, open_checkpointer(path))  # fresh graph + new connection
    assert resume(graph2, 't5', payload['request_id'])['status'] == 'completed'
    assert effects(backend) == (1, 1)


def test_node_replay_and_repeated_resume_do_not_duplicate_effect(stack):
    backend, gateway, graph, _, _ = stack
    start(graph, 't6', 'apply_record_update', ARGS)
    (payload,) = pending_interrupt(graph, 't6')
    gateway.approvals.approve(payload['request_id'], 'user-maple-001')
    first = resume(graph, 't6', payload['request_id'])
    config = {'configurable': {'thread_id': 't6'}}
    # Replay from the checkpoint taken before `execute` ran (as after a crash mid-node).
    before_execute = [s for s in graph.get_state_history(config) if s.next == ('execute',)][0]
    replayed = graph.invoke(None, before_execute.config)
    assert replayed['result'] == first['result']
    assert effects(backend) == (1, 1)
    # Replay the interrupted gate node as well.
    before_gate = [s for s in graph.get_state_history(config) if s.next == ('gate',)][0]
    assert graph.invoke(Command(resume={'request_id': payload['request_id'], 'approved': True}),
                        before_gate.config)['status'] == 'completed'
    assert effects(backend) == (1, 1)
    again = resume(graph, 't6', payload['request_id'])
    assert again['result'] == first['result'] and effects(backend) == (1, 1)


def test_expired_approval_blocks_resume(stack):
    backend, gateway, graph, _, _ = stack
    start(graph, 't7', 'apply_record_update', ARGS)
    (payload,) = pending_interrupt(graph, 't7')
    gateway.approvals.approve(payload['request_id'], 'user-maple-001')
    with backend.store._connect() as db:
        db.execute('UPDATE action_approvals SET expires_at=0 WHERE request_id=?', (payload['request_id'],))
    final = resume(graph, 't7', payload['request_id'])
    assert final['status'] == 'denied' and final['http_status'] == 403
    assert effects(backend) == (0, 0)


def test_two_threads_same_action_share_one_pending_request_and_one_effect(stack):
    backend, gateway, graph, _, _ = stack
    start(graph, 'a', 'apply_record_update', ARGS)
    start(graph, 'b', 'apply_record_update', ARGS)
    (pa,), (pb,) = pending_interrupt(graph, 'a'), pending_interrupt(graph, 'b')
    assert pa['request_id'] == pb['request_id']
    gateway.approvals.approve(pa['request_id'], 'user-maple-001')
    ra, rb = resume(graph, 'a', pa['request_id']), resume(graph, 'b', pb['request_id'])
    assert ra['result'] == rb['result'] and effects(backend) == (1, 1)
