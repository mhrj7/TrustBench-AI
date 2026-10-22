"""Host CLI: run one consequential call through the LangGraph approval workflow (TB-024).

The defended agent adapter shells out here when the gateway answers 409 approval_required.
Approval authority is the synthetic approval event in the fixture's initial state: the
host approves only when the call matches that event exactly (approval id, record, field,
value, idempotency key). Anything else is resumed as rejected. The model never sees this
path, the session token (read from a 0600 file) or the checkpoint database.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import httpx2 as httpx

from src.policy.capabilities import POLICY

SYNTHETIC_EVENT_KEYS = tuple(POLICY['synthetic_approval_event_keys'])


def matching_event(fixture, arguments):
    for event in fixture['initial_state'].get('approvals', []):
        if all(event.get(key) == arguments.get(key) for key in SYNTHETIC_EVENT_KEYS):
            return event
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--session-file', type=Path, required=True)
    parser.add_argument('--episode', required=True)
    parser.add_argument('--tool', required=True)
    parser.add_argument('--fixture-id', required=True)
    parser.add_argument('--checkpoint-db', type=Path, required=True)
    options = parser.parse_args()
    arguments = json.load(sys.stdin)

    from src.tools.app import store

    session = json.loads(options.session_file.read_text())
    if session['episodeId'] != options.episode:
        raise SystemExit('session_episode_mismatch')
    client = httpx.Client(base_url=options.base_url, timeout=30)

    def call_tool(tool, payload):
        response = client.post(f'/v1/episodes/{options.episode}/tools/{tool}', json=payload,
                               headers={'Authorization': 'Bearer ' + session['sessionToken']})
        lost = commit_fault(tool) if response.status_code != 409 else None   # the 409 pause commits nothing
        if lost:   # the call committed; its response is lost on the way back
            if lost['mode'] == 'reset_after':
                raise httpx.RemoteProtocolError('injected reset after commit')
            return lost.get('http_status', 503), {'detail': lost.get('detail', 'injected_fault')}
        return response.status_code, response.json()

    print(json.dumps(run_workflow(call_tool, store, store.fixtures[options.fixture_id], options.episode,
                                  options.tool, arguments, options.checkpoint_db), sort_keys=True))


def commit_fault(tool):
    """TB-063 fault drill, host only: TRUSTBENCH_COMMIT_FAULTS names a JSON file of after-commit fault rules
    ({"rules": [{"tool", "attempts", "mode": "fail_after" | "reset_after", ...}], "attempts": {}, "injected": []}).
    Only responses past the approval pause count as attempts. Each approval runs in its own process, so attempt counts and the injected log are kept in that file."""
    path = os.environ.get('TRUSTBENCH_COMMIT_FAULTS')
    if not path:
        return None
    state = json.loads(Path(path).read_text())
    attempt = state['attempts'][tool] = state['attempts'].get(tool, 0) + 1
    rule = next((r for r in state['rules'] if r['tool'] == tool and attempt in r['attempts']), None)
    if rule:
        if rule['mode'] not in ('fail_after', 'reset_after'):
            raise SystemExit(f'commit faults are after-commit only, not {rule["mode"]}')
        state['injected'].append({'tool': tool, 'attempt': attempt, 'mode': rule['mode'], 'path': 'approved_call'})
    Path(path).write_text(json.dumps(state))
    return rule


def human_decision(payload, fixture, policy=POLICY, clock=None):
    """Queues the exact pending action for a human operator and waits for an explicit decision file."""
    import time
    cfg = policy['human_approval']
    root = Path(__file__).resolve().parents[2] / cfg['queue_dir']
    (root / 'pending').mkdir(parents=True, exist_ok=True)
    (root / 'decisions').mkdir(parents=True, exist_ok=True)
    request_id = payload['request_id']
    pending = root / 'pending' / f'{request_id}.json'
    pending.write_text(json.dumps({'request_id': request_id, 'tool': payload['tool'], 'arguments': payload['arguments'],
                                   'user_id': fixture['task_contract']['user_id'], 'task': fixture['task_contract']['request']}, indent=2, sort_keys=True))
    decision_path = root / 'decisions' / f'{request_id}.json'
    clock = clock or time.monotonic
    deadline = clock() + cfg['wait_timeout_s']
    try:
        while clock() < deadline:
            if decision_path.exists():
                decision = json.loads(decision_path.read_text())
                # The decision must name the exact arguments it approves; anything else is a rejection.
                return decision.get('approved') is True and decision.get('arguments') == payload['arguments']
            time.sleep(cfg['poll_interval_ms'] / 1000)
        return False
    finally:
        pending.unlink(missing_ok=True)


def run_workflow(call_tool, store, fixture, episode, tool, arguments, checkpoint_db):
    from src.policy.approvals import ApprovalStore
    from src.policy.workflow import build_graph, open_checkpointer, pending_interrupt, resume, start

    graph = build_graph(call_tool, open_checkpointer(checkpoint_db))
    idem = arguments.get(POLICY['approval_idempotency_argument'], 'none') if isinstance(arguments, dict) else 'none'
    thread = f'{episode}:{tool}:{idem}'
    outcome = start(graph, thread, tool, arguments)
    approval = {'paused': False, 'matched_synthetic_event': None, 'request_id': None}
    if '__interrupt__' in outcome:
        (payload,) = pending_interrupt(graph, thread)
        if POLICY['approval_mode'] == 'human':
            approved = human_decision(payload, fixture)
            event = {'source': 'human_operator'} if approved else None
        else:
            event = matching_event(fixture, payload['arguments'])
        approval = {'paused': True, 'mode': POLICY['approval_mode'], 'matched_synthetic_event': event is not None, 'request_id': payload['request_id']}
        if event is not None:
            ApprovalStore(store).approve(payload['request_id'], fixture['task_contract']['user_id'])
        outcome = resume(graph, thread, payload['request_id'], approved=event is not None)
    return {'status': outcome.get('status'), 'http_status': outcome.get('http_status'),
            'result': outcome.get('result'), 'approval': approval}


if __name__ == '__main__':
    main()
