import json
from dataclasses import dataclass
from src.tools.schemas import QueryRequest, ResourceRequest, ResearchNoteRequest, EmailDraftRequest, RecordUpdateRequest

SCHEMAS = {'search_documents':QueryRequest, 'read_document':ResourceRequest,
 'read_reference':ResourceRequest, 'lookup_contact':ResourceRequest,
 'read_customer_record':ResourceRequest, 'save_research_note':ResearchNoteRequest,
 'create_email_draft':EmailDraftRequest, 'propose_record_update':RecordUpdateRequest,
 'apply_record_update':RecordUpdateRequest}

@dataclass(frozen=True)
class Capability:
    episode_id: str
    generation: int
    user_id: str
    tenant_id: str
    allowed_tools: frozenset[str]
    contract_json: str

    @classmethod
    def issue(cls, store, episode, tools, user_id=None):
        snapshot=store.snapshot(episode)
        fixture=store.fixtures[snapshot['fixture_id']]
        contract=fixture['task_contract']
        user=contract['user_id']
        if user_id is not None and user_id != user: raise ValueError('user_scope_mismatch')
        if not set(tools)<=set(contract['allowed_tools']) or not set(tools)<=set(SCHEMAS):
            raise ValueError('capability_escalation')
        return cls(episode,snapshot['generation'],user,fixture['tenant_id'],frozenset(tools),json.dumps(contract,sort_keys=True))

    def validate(self, tool, args):
        if tool not in self.allowed_tools or tool not in SCHEMAS: raise ValueError('operation_denied')
        # Strict type/schema validation and exact opaque IDs: never URL-decode, trim,
        # case-fold, normalize Unicode, or silently drop unknown fields.
        clean=SCHEMAS[tool].model_validate(args,strict=True).model_dump()
        c=json.loads(self.contract_json)
        docs=c.get('allowed_document_ids',c.get('reference_document_ids',[]))
        expected={}
        if tool in ('read_document','read_reference'):
            if clean['resource_id'] not in docs: raise ValueError('resource_denied')
        elif tool=='lookup_contact':expected={'resource_id':c.get('recipient_id')}
        elif tool=='read_customer_record':expected={'resource_id':c.get('record_id')}
        elif tool=='save_research_note':
            expected={'note_id':c.get('allowed_note_id')}
            if not set(clean['citation_document_ids'])<=set(docs):raise ValueError('citation_denied')
        elif tool=='create_email_draft':
            expected={k:c.get(k) for k in ('draft_id','recipient_id','subject','idempotency_key')}
            if not all(s in clean['body'] for s in c.get('required_body_fragments',[])):raise ValueError('required_content_missing')
        elif tool in ('propose_record_update','apply_record_update'):
            expected={k:c.get(k) for k in ('record_id','field','value','approval_id','idempotency_key')}
        if any(clean.get(k)!=v for k,v in expected.items()):raise ValueError('argument_scope_denied')
        return clean

    def manifest(self):
        return {'version':'tb021.1','episode_id':self.episode_id,'generation':self.generation,
                'user_id':self.user_id,'tenant_id':self.tenant_id,'allowed_tools':sorted(self.allowed_tools),
                'contract':json.loads(self.contract_json),'unknown_operations':'deny','identifier_normalization':'exact_only'}
