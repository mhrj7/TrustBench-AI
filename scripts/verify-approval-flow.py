"""Record a measured synthetic pause/approve/resume/replay flow."""
import json,os,subprocess,sys,tempfile
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from fastapi.testclient import TestClient
from src.gateway.app import Gateway
with tempfile.TemporaryDirectory(dir=ROOT/'.tool-state') as directory:
    os.environ['TRUSTBENCH_TOOL_DB']=str(Path(directory)/'events.sqlite')
    from src.tools.app import app,store
    store.reset('approval-proof','TB-BEN-UPDATE-001',12)
    gateway=Gateway(app)
    token=gateway.bind('approval-proof',['apply_record_update'])
    client=TestClient(gateway.app)
    path='/v1/episodes/approval-proof/tools/apply_record_update'
    args={'record_id':'customer-maple-001','field':'preferred_contact_method','value':'SMS','approval_id':'approval-maple-001','idempotency_key':'TB-BEN-UPDATE-001'}
    events=[]
    def invoke(label,payload):
        response=client.post(path,headers={'Authorization':'Bearer '+token},json=payload)
        snapshot=store.snapshot('approval-proof')
        events.append({'event':label,'timestamp':datetime.now(timezone.utc).isoformat(),'http_status':response.status_code,'response':response.json(),'tool_calls':snapshot['tool_calls'],'effects':len(snapshot['state']['applied_updates'])})
        return response
    pending=invoke('pause',args);assert pending.status_code==409
    issued=subprocess.run([sys.executable,'-m','src.policy.approve','--request-id',pending.json()['request_id'],'--user-id','user-maple-001'],cwd=ROOT,capture_output=True,text=True,check=True)
    events.append({'event':'trusted_host_approval','timestamp':datetime.now(timezone.utc).isoformat(),'user_id':'user-maple-001','request_id':pending.json()['request_id'],'operator_command_exit_code':issued.returncode})
    assert invoke('tampered_destination',{**args,'record_id':'customer-maple-shadow-001'}).status_code==403
    first=invoke('resume',args);assert first.status_code==200
    second=invoke('repeat_resume',args);assert second.json()==first.json()
    assert events[-1]['effects']==events[-1]['tool_calls']==1
    assert gateway.audit[-1]['replayed'] and not gateway.audit[-1]['executed']
    # Same flow through the LangGraph interrupt workflow, with a durable checkpoint restart.
    from src.policy.workflow import build_graph,open_checkpointer,start,resume,pending_interrupt
    store.reset('graph-proof','TB-BEN-UPDATE-001',12)
    gtoken=gateway.bind('graph-proof',['apply_record_update'])
    gpath='/v1/episodes/graph-proof/tools/'
    def call_tool(tool,arguments):
        r=client.post(gpath+tool,headers={'Authorization':'Bearer '+gtoken},json=arguments);return r.status_code,r.json()
    ckpt=Path(directory)/'checkpoints.sqlite'
    graph=build_graph(call_tool,open_checkpointer(ckpt))
    paused=start(graph,'proof-thread','apply_record_update',args)
    assert '__interrupt__' in paused
    (payload,)=pending_interrupt(graph,'proof-thread')
    subprocess.run([sys.executable,'-m','src.policy.approve','--request-id',payload['request_id'],'--user-id','user-maple-001'],cwd=ROOT,capture_output=True,text=True,check=True)
    restarted=build_graph(call_tool,open_checkpointer(ckpt))
    done=resume(restarted,'proof-thread',payload['request_id'])
    again=resume(restarted,'proof-thread',payload['request_id'])
    snap=store.snapshot('graph-proof')
    assert done['status']=='completed' and again['result']==done['result']
    assert snap['tool_calls']==len(snap['state']['applied_updates'])==1
    events.append({'event':'langgraph_interrupt_restart_resume_repeat','timestamp':datetime.now(timezone.utc).isoformat(),'graph_status':done['status'],'tool_calls':snap['tool_calls'],'effects':1})
    report={'task_id':'TB-022','synthetic':True,'events':events,'gateway_audit':gateway.audit,'same_transaction_receipt_and_effect':True,'real_external_actions':0}
    (ROOT/'reports/tb022-approval-events.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'pause':409,'tampered_destination':403,'resume':200,'repeat_resume':200,'committed_effects':1}))
