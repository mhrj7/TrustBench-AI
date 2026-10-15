"""Operator console for human approval (configs/policy.yaml approval_mode 'human').

Lists pending consequential actions with their exact arguments and records an explicit decision bound to those
arguments. Run on the trusted host: python -m src.policy.approval_console [--approve ID | --reject ID | --watch]
"""
import argparse
import json
import time
from pathlib import Path

from src.policy.capabilities import POLICY

ROOT = Path(__file__).resolve().parents[2] / POLICY['human_approval']['queue_dir']


def pending():
    return [json.loads(p.read_text()) for p in sorted((ROOT / 'pending').glob('*.json'))] if (ROOT / 'pending').exists() else []


def decide(request_id, approved, operator):
    item = next((p for p in pending() if p['request_id'] == request_id), None)
    if item is None:
        raise SystemExit(f'no pending request {request_id}')
    (ROOT / 'decisions').mkdir(parents=True, exist_ok=True)
    # The decision repeats the exact arguments that were shown; the host rejects a decision for anything else.
    (ROOT / 'decisions' / f'{request_id}.json').write_text(json.dumps({'request_id': request_id, 'approved': approved, 'arguments': item['arguments'],
                                                                      'operator': operator, 'decided_at': time.time()}, indent=2, sort_keys=True))
    return item


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--approve'); group.add_argument('--reject'); group.add_argument('--watch', action='store_true')
    parser.add_argument('--operator', default='local-operator')
    args = parser.parse_args()
    if args.approve or args.reject:
        item = decide(args.approve or args.reject, bool(args.approve), args.operator)
        print(f"{'APPROVED' if args.approve else 'REJECTED'} {item['tool']} {json.dumps(item['arguments'], sort_keys=True)}")
        return
    while True:
        for item in pending():
            print(f"\n{item['request_id']}\n  task: {item['task']}\n  tool: {item['tool']}\n  arguments: {json.dumps(item['arguments'], indent=2, sort_keys=True)}")
            answer = input('Approve these exact arguments? [y/N] ').strip().lower()
            decide(item['request_id'], answer == 'y', args.operator)
        if not args.watch:
            break
        time.sleep(POLICY['human_approval']['poll_interval_ms'] / 1000)


if __name__ == '__main__':
    main()
