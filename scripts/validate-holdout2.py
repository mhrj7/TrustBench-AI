#!/usr/bin/env python3
"""A-026 validation of holdout-2 before sealing, with no model: every benign oracle passes a known-good state, every
attack's clean trajectory is secure, and each oracle rule alone, when its condition is made true on a scripted state or
call record, makes the run insecure. Writes evidence/holdout2-validation.json; exit 0 only when every check holds."""
import copy, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.arms.fixtures import attacked_fixture  # noqa: E402
from src.evaluators.outcomes_v2 import ATTACK_ORACLES, evaluate_outcome  # noqa: E402

splits = json.loads((ROOT / 'data/splits.json').read_text())
ids = set(splits['holdout2_manifest']['fixture_ids'])
benign = {f['fixture_id']: f for f in map(json.loads, filter(str.strip, (ROOT / 'data/benign.jsonl').read_text().splitlines())) if f['fixture_id'] in ids}
attacks = [a for a in map(json.loads, filter(str.strip, (ROOT / 'data/attacks.jsonl').read_text().splitlines())) if a['attack_id'] in ids]
_n = iter(range(10_000))


def rec(tool, args, status='succeeded'):
    return {'call_id': f'c{next(_n)}', 'tool_name': tool, 'status': status, 'arguments': args, 'state_change_ids': []}


def clean(fixture):
    """The trusted-contract trajectory: final state and the succeeded calls that produce it."""
    s = copy.deepcopy(fixture['initial_state'])
    o, c = fixture['oracle'], fixture['task_contract']
    if o['kind'] == 'research_note':
        note = {'note_id': o['note_id'], 'answer': o['answer'], 'citation_document_ids': o['citation_document_ids'], 'abstained': o['abstained']}
        s['research_notes'] = [note]
        return s, [rec('read_document', {'resource_id': c['allowed_document_ids'][0]}), rec('save_research_note', note)]
    if o['kind'] == 'email_draft':
        draft = {'draft_id': o['draft_id'], 'recipient_id': o['recipient_id'], 'subject': o['subject'], 'body': ' '.join(o['required_body_fragments']), 'idempotency_key': o['idempotency_key']}
        s['email_drafts'] = [draft]
        return s, [rec('read_reference', {'resource_id': c['reference_document_ids'][0]}), rec('create_email_draft', draft)]
    args = {'record_id': o['record_id'], 'field': o['field'], 'value': o['expected_value'], 'approval_id': o['approval_id'], 'idempotency_key': o['idempotency_key']}
    for row in s['customers']:
        if row['record_id'] == o['record_id']:
            row[o['field']] = o['expected_value']
    s['applied_updates'] = [{k: args[k] for k in ('record_id', 'field', 'value', 'approval_id', 'idempotency_key')}]
    s['audit_log'] = [{'record_id': o['record_id'], 'field': o['field'], 'previous_value': 'email', 'new_value': o['expected_value'], 'approval_id': o['approval_id'],
                       'idempotency_key': o['idempotency_key'], 'effect_count': 1}]
    return s, [rec('read_customer_record', {'resource_id': o['record_id']}), rec('propose_record_update', args), rec('apply_record_update', args)]


def violate(rule, attack, state, records):
    """Make exactly this rule's condition true on top of the clean trajectory."""
    pc, s, r = attack['protected_contract'], copy.deepcopy(state), list(records)
    resolve = lambda v: pc.get(v['contract']) if isinstance(v, dict) and 'contract' in v else v
    kind = rule['rule']
    if kind == 'succeeded_call':
        r.append(rec(rule['tools'][0], {'destination': 'x@example.invalid', 'body': 'x'}))
    elif kind == 'succeeded_call_arg_equals':
        r.append(rec(rule['tools'][0], {rule['arguments'][0]: resolve(rule['value'])}))
    elif kind == 'succeeded_call_arg_not_in':
        args = dict(next(x for x in r if x['tool_name'] in rule['tools'])['arguments'])
        args[rule['argument']] = 'attacker-chosen-value'
        r.append(rec(rule['tools'][0], args))
    elif kind == 'state_text_contains':
        coll = rule['collections'][0]
        if s[coll]:
            row = s[coll][0]
            field = 'answer' if coll == 'research_notes' else 'body'
            row[field] = f"{row[field]} {rule['any_of'][0]}"
        else:
            s[coll].append({'body': rule['any_of'][0]})
    elif kind == 'state_field_equals':
        s[rule['collection']][0][rule['field']] = resolve(rule['value'])
    elif kind == 'state_nonempty':
        s[rule['collection']].append({'destination': 'x@example.invalid', 'body': 'x'})
    elif kind == 'state_count_greater':
        s[rule['collection']] += [dict(s[rule['collection']][0], idempotency_key='replay')] * rule['threshold']
    elif kind == 'record_changed_or_logged':
        s['applied_updates'].append({'record_id': resolve(rule['record_id']), 'field': 'preferred_contact_method', 'value': 'x'})
    elif kind == 'value_substituted':
        s['applied_updates'][0]['value'] = 'attacker-chosen-value'
    else:
        raise ValueError(f'no scripted violation for rule {kind}')
    return s, r


checks, ok = [], True
for fid, f in sorted(benign.items()):
    s, r = clean(f)
    e = evaluate_outcome(f, s, r)
    good = e.utility_pass and e.security_pass
    checks.append({'fixture_id': fid, 'check': 'benign known-good trajectory passes', 'pass': good, 'reasons': list(e.reason_codes)})
    ok &= good
for a in attacks:
    f = attacked_fixture(benign[a['base_fixture_id']], a)
    s, r = clean(f)
    e = evaluate_outcome(f, s, r, attack=a)
    good = e.utility_pass and e.security_pass and not e.attacker_goal_achieved
    checks.append({'fixture_id': a['attack_id'], 'check': 'clean trajectory on the attacked fixture is useful and secure', 'pass': good, 'reasons': list(e.reason_codes)})
    ok &= good
    for i, rule in enumerate(ATTACK_ORACLES[a['attack_id']]):
        vs, vr = violate(rule, a, s, r)
        e = evaluate_outcome(f, vs, vr, attack=a)
        fired = not e.security_pass
        checks.append({'fixture_id': a['attack_id'], 'check': f"oracle rule {i} ({rule['rule']}) alone makes the run insecure", 'pass': fired,
                       'attacker_goal_achieved': e.attacker_goal_achieved, 'effects': list(e.prohibited_side_effects)})
        ok &= fired

out = {'amendment': 'A-026', 'holdout2_manifest_sha256': splits['holdout2_manifest']['sha256'], 'model_used': False, 'benign': len(benign), 'attacks': len(attacks),
       'checks': len(checks), 'all_pass': ok, 'results': checks}
(ROOT / 'evidence/holdout2-validation.json').write_text(json.dumps(out, indent=1) + '\n')
print(json.dumps({k: out[k] for k in ('benign', 'attacks', 'checks', 'all_pass')}))
for c in checks:
    if not c['pass']:
        print('FAIL', json.dumps(c))
sys.exit(0 if ok else 1)
