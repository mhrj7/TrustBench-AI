import json
from dataclasses import dataclass
from pathlib import Path

import src.tools.schemas as schema_module

POLICY = json.loads((Path(__file__).resolve().parents[2] / 'configs/policy.yaml').read_text())
SCHEMAS = {tool: getattr(schema_module, name) for tool, name in POLICY['tool_argument_schemas'].items()}

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
        docs=next((c[key] for key in POLICY['document_allowlist_contract_keys'] if key in c), [])
        if tool in POLICY['document_resource_arguments'] and clean[POLICY['document_resource_arguments'][tool]] not in docs:
            raise ValueError('resource_denied')
        if tool in POLICY['citation_arguments'] and not set(clean[POLICY['citation_arguments'][tool]])<=set(docs):
            raise ValueError('citation_denied')
        fragments=POLICY['required_fragments'].get(tool)
        if fragments and not all(s in clean[fragments['argument']] for s in c.get(fragments['contract_key'],[])):
            raise ValueError('required_content_missing')
        expected={arg:c.get(key) for arg,key in POLICY['contract_bindings'].get(tool,{}).items()}
        if any(clean.get(k)!=v for k,v in expected.items()):raise ValueError('argument_scope_denied')
        return clean

    def manifest(self):
        return {'version':'tb021.1','episode_id':self.episode_id,'generation':self.generation,
                'user_id':self.user_id,'tenant_id':self.tenant_id,'allowed_tools':sorted(self.allowed_tools),
                'contract':json.loads(self.contract_json),'unknown_operations':'deny','identifier_normalization':'exact_only'}
