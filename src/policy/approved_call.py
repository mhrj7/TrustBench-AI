"""Host CLI: run one consequential call through the LangGraph approval workflow (TB-024).

The defended agent adapter shells out here when the gateway answers 409 approval_required.
Approval authority is the synthetic approval event in the fixture's initial state: the
host approves only when the call matches that event exactly (approval id, record, field,
value, idempotency key). Anything else is resumed as rejected. The model never sees this
path, the session token (read from a 0600 file) or the checkpoint database.
"""
import argparse
import json
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
        return response.status_code, response.json()

    print(json.dumps(run_workflow(call_tool, store, store.fixtures[options.fixture_id], options.episode,
                                  options.tool, arguments, options.checkpoint_db), sort_keys=True))


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
        event = matching_event(fixture, payload['arguments'])
        approval = {'paused': True, 'matched_synthetic_event': event is not None, 'request_id': payload['request_id']}
        if event is not None:
            ApprovalStore(store).approve(payload['request_id'], fixture['task_contract']['user_id'])
        outcome = resume(graph, thread, payload['request_id'], approved=event is not None)
    return {'status': outcome.get('status'), 'http_status': outcome.get('http_status'),
            'result': outcome.get('result'), 'approval': approval}


if __name__ == '__main__':
    main()
