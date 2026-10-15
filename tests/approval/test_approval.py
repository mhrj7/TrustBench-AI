import importlib,sys
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from src.gateway.app import Gateway
from src.tools.store import EpisodeStore, ToolError
from src.policy.approvals import ApprovalStore, execution_context
from src.policy.capabilities import Capability

ARGS={'record_id':'customer-maple-001','field':'preferred_contact_method','value':'SMS','approval_id':'approval-maple-001','idempotency_key':'TB-BEN-UPDATE-001'}
PATH='/v1/episodes/update/tools/apply_record_update'

@pytest.fixture
def setup(tmp_path,monkeypatch):
    monkeypatch.setenv('TRUSTBENCH_TOOL_DB',str(tmp_path/'state.sqlite'))
    sys.modules.pop('src.tools.app',None)
    backend=importlib.import_module('src.tools.app')
    backend.store.reset('update','TB-BEN-UPDATE-001',12)
    gateway=Gateway(backend.app)
    token=gateway.bind('update',backend.store.fixtures['TB-BEN-UPDATE-001']['task_contract']['allowed_tools'])
    return backend,gateway,TestClient(gateway.app),{'Authorization':'Bearer '+token}

def approve(setup):
    backend,gateway,client,headers=setup
    before=backend.store.snapshot('update')
    pending=client.post(PATH,headers=headers,json=ARGS)
    assert pending.status_code==409 and pending.json()['detail']=='approval_required'
    assert backend.store.snapshot('update')==before
    request_id=pending.json()['request_id']
    gateway.approvals.approve(request_id,'user-maple-001')
    return request_id

def test_resume_and_repeated_resume_produce_one_effect(setup):
    backend,gateway,client,headers=setup
    approve(setup)
    first=client.post(PATH,headers=headers,json=ARGS)
    second=client.post(PATH,headers=headers,json=ARGS)
    assert first.status_code==second.status_code==200
    assert first.json()==second.json()
    assert gateway.audit[-1]['replayed'] is True
    assert gateway.audit[-1]['executed'] is False
    state=backend.store.snapshot('update')
    assert state['tool_calls']==1
    assert len(state['state']['applied_updates'])==len(state['state']['audit_log'])==1

@pytest.mark.parametrize('field,value',[('record_id','customer-maple-shadow-001'),('value','email'),('approval_id','forged'),('idempotency_key','other')])
def test_changed_arguments_cannot_reuse_grant(setup,field,value):
    backend,_,client,headers=setup
    approve(setup);before=backend.store.snapshot('update')
    assert client.post(PATH,headers=headers,json={**ARGS,field:value}).status_code==403
    assert backend.store.snapshot('update')==before

@pytest.mark.parametrize('mode',['expired','revoked','reset'])
def test_expired_revoked_or_reset_approvals_cannot_execute(setup,mode):
    backend,gateway,client,headers=setup
    request_id=approve(setup)
    if mode=='expired':
        with backend.store._connect() as db:db.execute('UPDATE action_approvals SET expires_at=0 WHERE request_id=?',(request_id,))
    elif mode=='revoked':gateway.approvals.revoke(request_id)
    else:backend.store.reset('update','TB-BEN-UPDATE-001',12)
    before=backend.store.snapshot('update')
    assert client.post(PATH,headers=headers,json=ARGS).status_code==403
    assert backend.store.snapshot('update')==before

def test_approval_event_requires_correct_user_and_cannot_be_reissued(setup):
    _,gateway,client,headers=setup
    request_id=client.post(PATH,headers=headers,json=ARGS).json()['request_id']
    with pytest.raises(ValueError):gateway.approvals.approve(request_id,'attacker')
    for ttl in [0,-1,301,float('inf'),float('nan')]:
        with pytest.raises(ValueError):gateway.approvals.approve(request_id,'user-maple-001',ttl)
    gateway.approvals.approve(request_id,'user-maple-001')
    with pytest.raises(ValueError):gateway.approvals.approve(request_id,'user-maple-001')
    assert client.post('/approvals/'+request_id+'/approve',json={}).status_code==404

def test_restart_preserves_grant_and_receipt(setup):
    backend,gateway,client,headers=setup
    approve(setup)
    replacement=Gateway(backend.app)
    token=replacement.bind('update',['apply_record_update'])
    new_client=TestClient(replacement.app);new_headers={'Authorization':'Bearer '+token}
    assert new_client.post(PATH,headers=new_headers,json=ARGS).status_code==200
    replacement2=Gateway(backend.app)
    token2=replacement2.bind('update',['apply_record_update'])
    assert TestClient(replacement2.app).post(PATH,headers={'Authorization':'Bearer '+token2},json=ARGS).status_code==200
    assert backend.store.snapshot('update')['tool_calls']==1

def test_transaction_rolls_back_receipt_and_effect_together(setup):
    backend,gateway,_,_=setup
    request_id=approve(setup)
    cap=Capability.issue(backend.store,'update',['apply_record_update'])
    context=execution_context.set({'capability':cap,'arguments':ARGS,'approval_request_id':request_id})
    before=backend.store.snapshot('update')
    def broken(contract,state,tenant):
        state['customers'][0]['preferred_contact_method']='SMS'
        raise RuntimeError('simulated failure before commit')
    try:
        with pytest.raises(RuntimeError):backend.store.execute('update','apply_record_update',broken)
    finally:execution_context.reset(context)
    assert backend.store.snapshot('update')==before
    with backend.store._connect() as db:
        assert db.execute('SELECT status FROM action_approvals WHERE request_id=?',(request_id,)).fetchone()['status']=='approved'

def test_concurrent_independent_store_connections_consume_once(setup):
    backend,_,_,_=setup
    request_id=approve(setup)
    cap=Capability.issue(backend.store,'update',['apply_record_update'])
    def invoke(_):
        store=EpisodeStore(backend.store.fixture_path,backend.store.database_path)
        token=execution_context.set({'capability':cap,'arguments':ARGS,'approval_request_id':request_id})
        def operation(contract,state,tenant):
            state['audit_log'].append({'once':True})
            return {'committed':True}
        try:return store.execute('update','apply_record_update',operation)
        finally:execution_context.reset(token)
    with ThreadPoolExecutor(max_workers=4) as pool: results=list(pool.map(invoke,range(4)))
    assert results==[{'committed':True}]*4
    state=backend.store.snapshot('update')
    assert state['tool_calls']==1 and len(state['state']['audit_log'])==1

def test_changed_argument_same_idempotency_key_is_not_new_approval(setup):
    backend,gateway,_,_=setup
    approve(setup)
    cap=Capability.issue(backend.store,'update',['apply_record_update'])
    with pytest.raises(ValueError,match='idempotency_arguments_changed'):
        gateway.approvals.request(cap,'apply_record_update',{**ARGS,'value':'different'})

def test_new_process_returns_persisted_result_without_reexecution(setup):
    import subprocess,os
    from pathlib import Path
    backend,_,client,headers=setup
    request_id=approve(setup)
    assert client.post(PATH,headers=headers,json=ARGS).status_code==200
    code='''
import json,os
from pathlib import Path
from src.tools.store import EpisodeStore
from src.policy.approvals import execution_context
from src.policy.capabilities import Capability
store=EpisodeStore(Path('data/benign.jsonl'),Path(os.environ['TB_TEST_DB']))
cap=Capability.issue(store,'update',['apply_record_update'])
args=json.loads(os.environ['TB_TEST_ARGS'])
token=execution_context.set({'capability':cap,'arguments':args,'approval_request_id':os.environ['TB_TEST_APPROVAL']})
def forbidden(*args):raise RuntimeError('duplicate execution after restart')
try:
 result=store.execute('update','apply_record_update',forbidden)
 assert result['effect_count']==1
 assert store.snapshot('update')['tool_calls']==1
finally:execution_context.reset(token)
'''
    import json
    result=subprocess.run([sys.executable,'-c',code],cwd=Path(__file__).resolve().parents[2],env={**os.environ,'TB_TEST_DB':str(backend.store.database_path),'TB_TEST_ARGS':json.dumps(ARGS),'TB_TEST_APPROVAL':request_id},capture_output=True,text=True,timeout=10)
    assert result.returncode==0,result.stderr

def test_transaction_rejects_reset_after_preflight_check(setup):
    backend,_,_,_=setup
    request_id=approve(setup)
    cap=Capability.issue(backend.store,'update',['apply_record_update'])
    backend.store.reset('update','TB-BEN-UPDATE-001',12)
    before=backend.store.snapshot('update')
    token=execution_context.set({'capability':cap,'arguments':ARGS,'approval_request_id':request_id})
    try:
        with pytest.raises(ToolError,match='stale_or_mismatched_capability'):
            backend.store.execute('update','apply_record_update',lambda *_: pytest.fail('must not execute'))
    finally:execution_context.reset(token)
    assert backend.store.snapshot('update')==before
