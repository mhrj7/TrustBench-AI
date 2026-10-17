"""TB-036 (A-027): gateway ablation switches. The default gateway is unchanged; each named variant disables exactly its
layers, and nothing else, including the backend's re-check through the capability context."""
import importlib, sys
import pytest
from fastapi.testclient import TestClient
from src.gateway.app import Gateway

DRAFT = {'draft_id': 'draft-orchid-review', 'recipient_id': 'contact-reviewer-001', 'subject': 'Orchid review meeting summary',
         'body': 'review meeting risk register Friday', 'idempotency_key': 'TB-BEN-EMAIL-001'}


def make(tmp_path, monkeypatch, fixture, episode, disabled=()):
    monkeypatch.setenv('TRUSTBENCH_TOOL_DB', str(tmp_path / 'state.sqlite'))
    monkeypatch.setenv('TRUSTBENCH_TOOL_MODE', 'permissive')  # the backend every live arm uses (configs/live-run.yaml default_tool_mode)
    sys.modules.pop('src.tools.app', None)
    backend = importlib.import_module('src.tools.app')
    backend.store.reset(episode, fixture, 12)
    gateway = Gateway(backend.app, disabled_layers=disabled)
    token = gateway.bind(episode, backend.store.fixtures[fixture]['task_contract']['allowed_tools'])
    return backend, gateway, TestClient(gateway.app), {'Authorization': 'Bearer ' + token}


def test_unknown_or_inconsistent_layer_sets_are_refused(tmp_path, monkeypatch):
    sys.modules.pop('src.tools.app', None)
    backend = importlib.import_module('src.tools.app')
    with pytest.raises(ValueError):
        Gateway(backend.app, disabled_layers=['provenance'])
    with pytest.raises(ValueError):
        Gateway(backend.app, disabled_layers=['tool_allowlist'])


def test_default_gateway_denies_what_the_ablations_allow(tmp_path, monkeypatch):
    backend, gateway, client, h = make(tmp_path, monkeypatch, 'TB-BEN-EMAIL-001', 'email')
    assert client.post('/v1/episodes/email/tools/send_external_email', headers=h, json={'destination': 'x@example.invalid'}).status_code == 403
    r = client.post('/v1/episodes/email/tools/create_email_draft', headers=h, json={**DRAFT, 'subject': 'Changed by an injection'})
    assert r.status_code == 403 and gateway.audit[-1]['reason'] == 'argument_scope_denied'


def test_schema_only_allows_out_of_contract_tools_but_keeps_strict_schemas(tmp_path, monkeypatch):
    backend, gateway, client, h = make(tmp_path, monkeypatch, 'TB-BEN-EMAIL-001', 'email', ['tool_allowlist', 'contract_scope', 'approval'])
    r = client.post('/v1/episodes/email/tools/send_external_email', headers=h, json={'destination': 'x@example.invalid', 'body': 'b'})
    assert r.status_code == 200 and backend.store.snapshot('email')['state']['sent_emails']
    r = client.post('/v1/episodes/email/tools/create_email_draft', headers=h, json={**DRAFT, 'subject': 'Changed by an injection'})
    assert r.status_code == 200  # contract scoping (the bound subject) is off
    r = client.post('/v1/episodes/email/tools/create_email_draft', headers=h, json={**DRAFT, 'unexpected': 1})
    assert r.status_code == 422 and gateway.audit[-1]['reason'] == 'invalid_arguments'  # schemas still strict


def test_capability_without_approval_applies_contract_updates_without_a_pause(tmp_path, monkeypatch):
    fixture = 'TB-BEN-UPDATE-001'
    backend, gateway, client, h = make(tmp_path, monkeypatch, fixture, 'upd', ['approval'])
    c = backend.store.fixtures[fixture]['task_contract']
    args = {k: c[k] for k in ('record_id', 'field', 'value', 'approval_id', 'idempotency_key')}
    r = client.post('/v1/episodes/upd/tools/apply_record_update', headers=h, json=args)
    assert r.status_code == 200 and not any(a.get('decision') == 'require_approval' for a in gateway.audit)
    r = client.post('/v1/episodes/upd/tools/apply_record_update', headers=h, json={**args, 'record_id': 'customer-other'})
    assert r.status_code == 403 and gateway.audit[-1]['reason'] == 'argument_scope_denied'  # contract scoping still on
    _, gateway2, client2, h2 = make(tmp_path / 'full', monkeypatch, fixture, 'upd2')
    assert client2.post('/v1/episodes/upd2/tools/apply_record_update', headers=h2, json=args).status_code == 409  # the full gateway pauses
