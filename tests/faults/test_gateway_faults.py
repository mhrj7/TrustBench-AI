"""TB-040 drills at the gateway: a tool backend that crashes and an audit store that cannot be written. Each must give an
explicit status, commit no effect, and never let a call through without its policy decision being durable."""
import importlib
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

from src.gateway.app import Gateway

NOTE = {'note_id': 'note-cedar-tier', 'answer': 'Silver', 'citation_document_ids': ['doc-cedar-policy'], 'abstained': False}


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setenv('TRUSTBENCH_TOOL_DB', str(tmp_path / 'episodes.sqlite'))
    monkeypatch.setenv('TRUSTBENCH_TEST_MODE', '1')
    sys.modules.pop('src.tools.app', None)
    module = importlib.import_module('src.tools.app')
    module.store.reset('doc', 'TB-BEN-DOC-001', 12)
    return module


def bound(backend, audit_path=None):
    gateway = Gateway(backend.app, audit_path=audit_path)
    token = gateway.bind('doc', ['read_document', 'save_research_note'])
    return gateway, TestClient(gateway.app, raise_server_exceptions=False), {'Authorization': 'Bearer ' + token}


def test_a_crashing_tool_gives_an_explicit_502_and_commits_nothing(backend, monkeypatch):
    gateway, client, headers = bound(backend)
    before = backend.store.snapshot('doc')
    def crash(*_args, **_kwargs):
        raise RuntimeError('drill: tool process crashed')
    monkeypatch.setattr(backend.store, 'execute', crash)
    r = client.post('/v1/episodes/doc/tools/save_research_note', headers=headers, json=NOTE)
    assert r.status_code == 502 and r.json() == {'detail': 'tool_backend_error'}
    assert gateway.audit[-1]['executed'] is False and gateway.audit[-1]['backend_error'] == 'RuntimeError'
    monkeypatch.undo()
    assert backend.store.snapshot('doc') == before


def test_the_gateway_recovers_after_a_tool_crash(backend, monkeypatch):
    gateway, client, headers = bound(backend)
    original = backend.store.execute
    monkeypatch.setattr(backend.store, 'execute', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('drill')))
    assert client.post('/v1/episodes/doc/tools/read_document', headers=headers, json={'resource_id': 'doc-cedar-policy'}).status_code == 502
    monkeypatch.setattr(backend.store, 'execute', original)
    assert client.post('/v1/episodes/doc/tools/read_document', headers=headers, json={'resource_id': 'doc-cedar-policy'}).status_code == 200


def test_an_unwritable_audit_store_fails_closed_with_503_and_no_effect(backend, tmp_path):
    audit = tmp_path / 'audit.jsonl'
    gateway, client, headers = bound(backend, audit_path=str(audit))
    ok = client.post('/v1/episodes/doc/tools/read_document', headers=headers, json={'resource_id': 'doc-cedar-policy'})
    assert ok.status_code == 200 and audit.with_name('audit.jsonl.intent').exists()
    before = backend.store.snapshot('doc')
    intent = audit.with_name('audit.jsonl.intent')
    # the log store becomes read-only (a full or failed disk behaves the same: the write raises OSError)
    for p in (audit, intent):
        os.chmod(p, 0o400)
    try:
        if os.access(intent, os.W_OK):
            pytest.skip('running as a user that ignores directory permissions')
        r = client.post('/v1/episodes/doc/tools/save_research_note', headers=headers, json=NOTE)
    finally:
        for p in (audit, intent):
            os.chmod(p, 0o600)
    assert r.status_code == 503 and r.json() == {'detail': 'audit_unavailable'}
    assert gateway.audit[-1]['decision'] == 'deny' and gateway.audit[-1]['reason'] == 'audit_unavailable'
    assert backend.store.snapshot('doc') == before, 'no effect committed without a durable decision'
    # once the store is writable again the decision log catches up (nothing is lost from the in-memory trail)
    assert client.post('/v1/episodes/doc/tools/save_research_note', headers=headers, json=NOTE).status_code == 200
    lines = [json.loads(l) for l in audit.read_text().splitlines()]
    assert [l['seq'] for l in lines] == list(range(len(lines))) and any(l.get('reason') == 'audit_unavailable' for l in lines)


def test_every_executed_call_has_a_durable_intent_written_before_it(backend, tmp_path):
    audit = tmp_path / 'audit.jsonl'
    gateway, client, headers = bound(backend, audit_path=str(audit))
    for _ in range(3):
        client.post('/v1/episodes/doc/tools/read_document', headers=headers, json={'resource_id': 'doc-cedar-policy'})
    intents = {json.loads(l)['seq'] for l in audit.with_name('audit.jsonl.intent').read_text().splitlines()}
    executed = {i for i, r in enumerate(gateway.audit) if r.get('executed')}
    assert executed and executed <= intents
