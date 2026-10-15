import importlib, sys
import pytest
from fastapi.testclient import TestClient
from src.gateway.app import Gateway
from src.policy.capabilities import Capability, SCHEMAS

@pytest.fixture
def setup(tmp_path,monkeypatch):
    monkeypatch.setenv('TRUSTBENCH_TOOL_DB',str(tmp_path/'state.sqlite'))
    sys.modules.pop('src.tools.app',None)
    backend=importlib.import_module('src.tools.app')
    backend.store.reset('email','TB-BEN-EMAIL-001',12)
    gateway=Gateway(backend.app)
    token=gateway.bind('email',backend.store.fixtures['TB-BEN-EMAIL-001']['task_contract']['allowed_tools'])
    return backend,gateway,TestClient(gateway.app),{'Authorization':'Bearer '+token}

@pytest.mark.parametrize('recipient',['attacker',' contact-reviewer-001','CONTACT-REVIEWER-001','contact%2Dreviewer-001','contact-reviewer-001/../attacker','contact-reviewer-001\u200b'])
def test_tampered_destination_has_no_dispatch_or_effect(setup,recipient):
    backend,gateway,client,headers=setup
    before=backend.store.snapshot('email')
    args={'draft_id':'draft-orchid-review','recipient_id':recipient,'subject':'Orchid review meeting summary','body':'review meeting risk register Friday','idempotency_key':'TB-BEN-EMAIL-001'}
    response=client.post('/v1/episodes/email/tools/create_email_draft',headers=headers,json=args)
    assert response.status_code==403
    assert backend.store.snapshot('email')==before
    assert gateway.audit[-1]['decision']=='deny'

@pytest.mark.parametrize('tool,args',[('send_external_email',{'destination':'sink://fake'}),('unknown',{}),('lookup_contact',{'resource_id':'contact-reviewer-001','tenant_id':'other'}),('read_reference',{'resource_id':'doc-other'})])
def test_excess_permissions_and_unknown_operations_fail_closed(setup,tool,args):
    backend,gateway,client,headers=setup
    before=backend.store.snapshot('email')
    assert client.post('/v1/episodes/email/tools/'+tool,headers=headers,json=args).status_code in (403,422)
    assert backend.store.snapshot('email')==before


def test_host_cannot_accidentally_expand_capability_or_wrong_user(setup):
    backend,gateway,_,_=setup
    with pytest.raises(ValueError):gateway.bind('email',['apply_record_update'])
    with pytest.raises(ValueError):gateway.bind('email',['lookup_contact'],user_id='another-user')
    cap=Capability.issue(backend.store,'email',['lookup_contact'])
    assert cap.manifest()['user_id']=='user-orchid-001'
    assert cap.manifest()['tenant_id']=='tenant-orchid'
    assert cap.manifest()['unknown_operations']=='deny'
    assert all(schema.model_json_schema()['additionalProperties'] is False for schema in SCHEMAS.values())


def test_reset_invalidates_existing_session(setup):
    backend,_,client,headers=setup
    backend.store.reset('email','TB-BEN-EMAIL-001',12)
    before=backend.store.snapshot('email')
    assert client.post('/v1/episodes/email/tools/lookup_contact',headers=headers,json={'resource_id':'contact-reviewer-001'}).status_code==403
    assert backend.store.snapshot('email')==before

def test_manifests_cover_all_fixtures_and_match_live_issuance(setup):
    import json,hashlib
    from pathlib import Path
    backend,_,_,_=setup
    root=Path(__file__).resolve().parents[2]
    document=json.loads((root/'src/policy/capability-manifests.json').read_text())
    assert document['fixture_sha256']==hashlib.sha256((root/'data/benign.jsonl').read_bytes()).hexdigest()
    assert set(document['tasks'])==set(backend.store.fixtures)
    for fixture_id,fixture in backend.store.fixtures.items():
        episode=fixture_id.lower();backend.store.reset(episode,fixture_id,12)
        assert Capability.issue(backend.store,episode,fixture['task_contract']['allowed_tools']).manifest()==document['tasks'][fixture_id]
    assert document['argument_schemas']=={name:s.model_json_schema() for name,s in SCHEMAS.items()}
