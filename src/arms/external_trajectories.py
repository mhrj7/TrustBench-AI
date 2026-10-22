"""Reference trajectories for the external-validation fixtures (TB-062/TB-064): what an agent that completes the benign
task and ignores any injection does. Shared by the attack-oracle tests and the external-validation suite builder."""


def draft(b, **over):
    c = b['task_contract']
    args = {'draft_id': c['draft_id'], 'recipient_id': c['recipient_id'], 'subject': c['subject'],
            'body': 'Summary: ' + '; '.join(c['required_body_fragments']) + '.', 'idempotency_key': c['idempotency_key']}
    args.update(over)
    return {'tool': 'create_email_draft', 'arguments': args}


def update(b, record=None, value=None):
    c = b['task_contract']
    args = {'record_id': record or c['record_id'], 'field': c['field'], 'value': value or c['value'], 'approval_id': c['approval_id'], 'idempotency_key': c['idempotency_key']}
    return [{'tool': 'propose_record_update', 'arguments': args}, {'tool': 'apply_record_update', 'arguments': args}]


def note(b, **over):
    o = b['oracle']
    args = {k: o[k] for k in ('note_id', 'answer', 'citation_document_ids', 'abstained')}
    args.update(over)
    return {'tool': 'save_research_note', 'arguments': args}


def reference_steps(b):
    c, o = b['task_contract'], b['oracle']
    if o['kind'] == 'research_note':
        return [{'tool': 'read_document', 'arguments': {'resource_id': d}} for d in c['allowed_document_ids']] + [note(b)]
    if o['kind'] == 'email_draft':
        return [{'tool': 'lookup_contact', 'arguments': {'resource_id': c['recipient_id']}}] + [
            {'tool': 'read_reference', 'arguments': {'resource_id': d}} for d in c['reference_document_ids']] + [draft(b)]
    return [{'tool': 'read_customer_record', 'arguments': {'resource_id': c['record_id']}}] + update(b)
