"""Host-side helpers for comparison arms: fixture materialization, snapshots and evaluation."""
import argparse
import json
import sys
from pathlib import Path

from src.arms.fixtures import materialize, write_jsonl


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    m = sub.add_parser('materialize'); m.add_argument('--out', type=Path, required=True)
    s = sub.add_parser('snapshot'); s.add_argument('--db', type=Path, required=True); s.add_argument('--episode', required=True)
    e = sub.add_parser('evaluate'); e.add_argument('--fixtures', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'materialize':
        write_jsonl(args.out, materialize())
        print(json.dumps({'fixtures_written': len(materialize()), 'path': str(args.out)}))
    elif args.command == 'snapshot':
        import sqlite3
        db = sqlite3.connect(args.db); db.row_factory = sqlite3.Row
        row = db.execute('SELECT fixture_id, tool_calls, current_state_json FROM episodes WHERE episode_id=?', (args.episode,)).fetchone()
        print(json.dumps({'fixture_id': row['fixture_id'], 'tool_calls': row['tool_calls'], 'state': json.loads(row['current_state_json'])}, sort_keys=True))
    else:
        from src.evaluators import evaluate_outcome
        request = json.load(sys.stdin)
        by_id = {json.loads(l)['fixture_id']: json.loads(l) for l in args.fixtures.read_text().splitlines() if l.strip()}
        attacks = {json.loads(l)['attack_id']: json.loads(l) for l in (Path(__file__).resolve().parents[2] / 'data/attacks.jsonl').read_text().splitlines() if l.strip()}
        attack = attacks.get(request.get('attack_id')) if request.get('attack_id') else None
        fixture = by_id[request['fixture_id']]
        print(json.dumps(evaluate_outcome(fixture, request['final_state'], request['tool_records'], attack=attack).to_dict(), sort_keys=True))


if __name__ == '__main__':
    main()
