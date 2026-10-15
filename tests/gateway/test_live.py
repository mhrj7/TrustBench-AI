"""Real TCP gateway plus the actual TypeScript agent adapter; no model/API calls."""
import json, os, socket, stat, subprocess, sys, time
from pathlib import Path
import httpx2 as httpx

ROOT=Path(__file__).resolve().parents[2]

def test_live_listener_and_typescript_adapter(tmp_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    session=tmp_path/'session.json'
    env={**os.environ,'TRUSTBENCH_TOOL_DB':str(tmp_path/'state.sqlite')}
    log=(tmp_path/'server.log').open('w')
    process=subprocess.Popen([sys.executable,'-m','src.gateway.serve','--fixture','TB-BEN-DOC-001','--episode','live','--session-file',str(session),'--port',str(port)],cwd=ROOT,env=env,stdout=log,stderr=log)
    try:
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            assert process.poll() is None, 'gateway exited early'
            try:
                response=httpx.get(f'http://127.0.0.1:{port}/health',timeout=0.2)
                if session.exists():break
            except httpx.HTTPError:time.sleep(0.05)
        else:raise AssertionError('gateway failed to start')
        assert stat.S_IMODE(session.stat().st_mode)==0o600
        base=f'http://127.0.0.1:{port}'
        assert httpx.post(base+'/v1/episodes/live/tools/read_document',json={'resource_id':'doc-cedar-policy'}).status_code==403
        assert httpx.post(base+'/v1/episodes/live/reset',json={'fixture_id':'TB-BEN-DOC-001'}).status_code==404
        code='''
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createGatewayToolRegistry} from './src/gateway/adapter.ts';
const config=JSON.parse(fs.readFileSync(process.env.TB_SESSION_FILE,'utf8'));
const tools=createGatewayToolRegistry(config);
const context={runId:'live-check',taskId:'TB-BEN-DOC-001',callId:'call-1',signal:new AbortController().signal};
const read=await tools.read_document.execute({resource_id:'doc-cedar-policy'},context);
assert.equal(read.output.payload.document_id,'doc-cedar-policy');
assert.equal(read.output.provenance.trust,'untrusted');
const write=await tools.save_research_note.execute({note_id:'note-cedar-tier',answer:'Silver',citation_document_ids:['doc-cedar-policy'],abstained:false},context);
assert.equal(write.output.payload.answer,'Silver');
assert.equal(write.output.provenance.trust,'untrusted');
console.log('real_gateway_adapter_read_write_passed');
'''
        result=subprocess.run(['node','--input-type=module','-e',code],cwd=ROOT,env={**os.environ,'TB_SESSION_FILE':str(session)},capture_output=True,text=True,timeout=10)
        assert result.returncode==0,result.stderr
        assert 'real_gateway_adapter_read_write_passed' in result.stdout
    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill();process.wait()
        log.close()
