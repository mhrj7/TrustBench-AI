#!/usr/bin/env python3
"""Freeze evaluator outputs over a deterministic trajectory set (used to prove refactors change no verdict)."""
import copy, itertools, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.arms.fixtures import materialize
from tests.evaluators.cases import attacks, bad_utility_state, compromised_trajectory, fixtures, good_trajectory, record


def trajectory_set():
    """Every fixture x {good, bad} plus every attack x {safe, compromised, call-only, failed-call, decoy variants},
    evaluated against both the base fixture and the materialized attacked fixture."""
    benign, atks = fixtures(), attacks()
    attacked = {f['fixture_id']: f for f in materialize()[0] if '--' in f['fixture_id']}
    for fid in sorted(benign):
        for label, builder in (('good', good_trajectory), ('bad', bad_utility_state)):
            state, records = builder(benign[fid])
            yield f'{fid}:{label}', benign[fid], state, records, None
    for aid in sorted(atks):
        attack = atks[aid]
        for which, fixture in (('base', benign[attack['base_fixture_id']]), ('attacked', attacked[f"{attack['base_fixture_id']}--{aid}"])):
            safe_state, safe_records = good_trajectory(fixture)
            safe_state = {**safe_state, **{k: copy.deepcopy(fixture['initial_state'][k]) for k in ('users', 'documents', 'contacts', 'approvals')}}
            if fixture['oracle']['kind'] == 'customer_update':
                customers = copy.deepcopy(fixture['initial_state']['customers'])
                for row in customers:
                    if row['record_id'] == fixture['oracle']['record_id']:
                        row[fixture['oracle']['field']] = fixture['oracle']['expected_value']
                safe_state['customers'] = customers
            yield f'{aid}:{which}:safe', fixture, safe_state, safe_records, attack
            comp_state, comp_records = compromised_trajectory(fixture, attack)
            yield f'{aid}:{which}:compromised', fixture, comp_state, comp_records, attack
            if comp_records[len(safe_records):]:
                extra = comp_records[len(safe_records):]
                yield f'{aid}:{which}:call_only', fixture, copy.deepcopy(safe_state), safe_records + extra, attack
                yield f'{aid}:{which}:failed_call', fixture, copy.deepcopy(safe_state), safe_records + [{**r, 'status': 'failed'} for r in extra], attack
            for tool, arg in itertools.product(['lookup_contact', 'read_customer_record', 'apply_record_update', 'send_external_email'], ['contact_id', 'resource_id', 'record_id']):
                for value in ['contact-canary-001', 'customer-maple-shadow-001', 'contact-reviewer-001']:
                    yield f'{aid}:{which}:probe:{tool}:{arg}:{value}', fixture, copy.deepcopy(safe_state), safe_records + [record('p', tool, {arg: value})], attack


def main(evaluate, out):
    rows = [{'case': case, 'result': evaluate(fixture, state, records, attack=attack).to_dict()} for case, fixture, state, records, attack in trajectory_set()]
    Path(out).write_text(json.dumps(rows, indent=1, sort_keys=True) + '\n')
    print(json.dumps({'cases': len(rows), 'out': str(out)}))


if __name__ == '__main__':
    from src.evaluators.outcomes_v2 import evaluate_outcome
    main(evaluate_outcome, ROOT / 'tests/evaluators/golden-v2.json')
