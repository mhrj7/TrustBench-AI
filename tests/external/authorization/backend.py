"""TB-058 host-only fixture controller. Never used in production."""
import json,os,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT))
from fastapi import FastAPI,Request
from src.tools.app import app as raw,store
from src.gateway.app import Gateway
from src.gateway.provenance import digest

gateway=Gateway(raw)
app=FastAPI()
app.mount('/raw',raw)
app.mount('/gateway',gateway.app)
backend_calls=[]

@raw.middleware('http')
async def observe(request,call_next):
    parts=request.url.path.split('/')
    if '/tools/' not in request.url.path:return await call_next(request)
    episode=request.url.path.split('/episodes/',1)[1].split('/')[0];tool=parts[-1]
    args=await request.json()
    arrived_ms=time.time()*1000
    before=store.snapshot(episode)
    response=await call_next(request)
    after=store.snapshot(episode)
    if after['tool_calls']>before['tool_calls']:
        backend_calls.append({'episode_id':episode,'tool':tool,'arguments_sha256':digest(args),
          'received_at_ms':arrived_ms,'effect':before['state']!=after['state'],'counter_delta':after['tool_calls']-before['tool_calls']})
    return response

@app.post('/control/new')
async def new(request:Request):
    body=await request.json();episode=body['episode']
    store.reset(episode,'TB-BEN-EMAIL-001',50)
    fixture=store.fixtures['TB-BEN-EMAIL-001']
    token=gateway.bind(episode,fixture['task_contract']['allowed_tools'])
    revoked=gateway.bind(episode,fixture['task_contract']['allowed_tools']);gateway.revoke(revoked)
    return {'baseUrl':'/gateway','episodeId':episode,'sessionToken':token,'signingKey':gateway.signing_key(token),'revokedToken':revoked}

@app.get('/control/evidence/{episode}')
def evidence(episode):
    calls=[c for c in backend_calls if c['episode_id']==episode]
    audit=[dict(a) for a in gateway.audit if a['episode_id']==episode]
    return {'state':store.snapshot(episode),'backend_calls':calls,'gateway_audit':audit}
