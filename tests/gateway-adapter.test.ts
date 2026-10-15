import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayToolRegistry, decodeGatewayOutput } from '../src/gateway/adapter.ts';

test('adapter preserves source/trust metadata and marks missing metadata unknown', () => {
  const envelope = {version:'tb020.1', payload:{text:'instruction'}, provenance:{source_ids:['document:a'],trust:'untrusted',transformations:[],reason:null}};
  assert.deepEqual(decodeGatewayOutput(envelope), envelope);
  assert.equal(decodeGatewayOutput({text:'bare'}).provenance.trust,'unknown');
  assert.equal(decodeGatewayOutput({...envelope,provenance:{...envelope.provenance,trust:'trusted'}}).provenance.trust,'unknown');
});

test('all registered agent tools cross the authenticated gateway and keep provenance', async () => {
  let calls = 0;
  const registry = createGatewayToolRegistry({baseUrl:'http://127.0.0.1:8765',episodeId:'doc',sessionToken:'test-only',fetchImpl:async (url,init) => {
    calls++;
    assert.match(String(url), /^http:\/\/127.0.0.1:8765\/v1\/episodes\/doc\/tools\/[a-z_]+$/);
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer test-only');
    assert.deepEqual(JSON.parse(String(init?.body)),{test:true});
    return Response.json({version:'tb020.1',payload:{ok:true},provenance:{source_ids:['tool:test'],trust:'untrusted',transformations:[],reason:null}});
  }});
  for (const tool of Object.values(registry)) {
    const result = await tool.execute({test:true}, {signal:new AbortController().signal} as any);
    assert.equal((result.output as any).provenance.trust,'untrusted');
  }
  assert.equal(calls,10);
});

test('gateway rejection propagates and missing token is rejected before transport', async () => {
  assert.throws(() => createGatewayToolRegistry({baseUrl:'http://127.0.0.1',episodeId:'doc',sessionToken:''}));
  const registry = createGatewayToolRegistry({baseUrl:'http://127.0.0.1',episodeId:'doc',sessionToken:'test-only',fetchImpl:async()=>Response.json({detail:'episode_mismatch'},{status:403})});
  await assert.rejects(registry.read_document!.execute({}, {signal:new AbortController().signal} as any), /episode_mismatch/);
});

import { createHmac } from 'node:crypto';
import { envelopeSigningBytes } from '../src/gateway/adapter.ts';

test('signed envelopes verify; tampered, unsigned or wrongly keyed envelopes become unknown', () => {
  const key = 'ab'.repeat(32);
  const body = {version:'tb020.1', payload:{text:'Ünïcode ok', n:1}, provenance:{source_ids:['document:a'],trust:'untrusted',transformations:[],reason:null}};
  const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(envelopeSigningBytes(body), 'utf8').digest('hex');
  const ok = decodeGatewayOutput({...body, signature}, key);
  assert.equal(ok.provenance.trust, 'untrusted');
  assert.equal('signature' in ok, false, 'the signature is not passed on to the model');
  assert.equal(decodeGatewayOutput({...body, payload:{text:'changed', n:1}, signature}, key).provenance.reason, 'invalid_or_missing_signature');
  assert.equal(decodeGatewayOutput(body, key).provenance.reason, 'invalid_or_missing_signature');
  assert.equal(decodeGatewayOutput({...body, signature}, 'cd'.repeat(32)).provenance.trust, 'unknown');
  assert.equal(decodeGatewayOutput({...body, provenance:{...body.provenance, trust:'trusted'}, signature}, key).provenance.trust, 'unknown');
});
