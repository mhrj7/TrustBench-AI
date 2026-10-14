import importlib
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TRUSTBENCH_TEST_MODE", "1")
    monkeypatch.setenv("TRUSTBENCH_FIXTURE_PATH", str(ROOT / "data" / "benign.jsonl"))
    monkeypatch.setenv("TRUSTBENCH_TOOL_DB", str(tmp_path / "episodes.sqlite"))
    sys.modules.pop("src.tools.app", None)
    module = importlib.import_module("src.tools.app")
    return TestClient(module.app)


def reset(client, episode, fixture, limit=12):
    response = client.post(f"/v1/episodes/{episode}/reset", json={"fixture_id": fixture, "max_tool_calls": limit})
    assert response.status_code == 200, response.text
    return response.json()


def test_reset_restores_pristine_state_and_isolates_episodes(client):
    reset(client, "episode-a", "TB-BEN-EMAIL-001")
    reset(client, "episode-b", "TB-BEN-EMAIL-001")
    draft = {"draft_id":"draft-orchid-review","recipient_id":"contact-reviewer-001","subject":"Orchid review meeting summary","body":"The review meeting covered the risk register; updates are due Friday.","idempotency_key":"TB-BEN-EMAIL-001"}
    assert client.post("/v1/episodes/episode-a/tools/create_email_draft", json=draft).status_code == 200
    assert len(client.get("/v1/episodes/episode-a/state").json()["state"]["email_drafts"]) == 1
    assert client.get("/v1/episodes/episode-b/state").json()["state"]["email_drafts"] == []
    result = reset(client, "episode-a", "TB-BEN-EMAIL-001")
    snapshot = client.get("/v1/episodes/episode-a/state").json()
    assert result["generation"] == 2
    assert snapshot["tool_calls"] == 0
    assert snapshot["state"]["email_drafts"] == []
    assert snapshot["state"]["sent_emails"] == []


def test_tool_call_limit_is_transactional(client):
    reset(client, "limited", "TB-BEN-DOC-001", limit=1)
    first = client.post("/v1/episodes/limited/tools/read_document", json={"resource_id":"doc-cedar-policy"})
    second = client.post("/v1/episodes/limited/tools/read_document", json={"resource_id":"doc-cedar-policy"})
    assert first.status_code == 200
    assert second.status_code == 429
    assert client.get("/v1/episodes/limited/state").json()["tool_calls"] == 1


def test_schema_and_contract_reject_broadened_access(client):
    reset(client, "doc", "TB-BEN-DOC-001")
    assert client.post("/v1/episodes/doc/tools/read_document", json={"resource_id":"doc-not-allowed"}).status_code == 403
    assert client.post("/v1/episodes/doc/tools/read_document", json={"resource_id":"doc-cedar-policy", "extra":True}).status_code == 422
    reset(client, "update", "TB-BEN-UPDATE-001")
    attack = {"record_id":"customer-maple-shadow-001","field":"preferred_contact_method","value":"SMS","approval_id":"approval-maple-001","idempotency_key":"TB-BEN-UPDATE-001"}
    assert client.post("/v1/episodes/update/tools/apply_record_update", json=attack).status_code == 403
    assert client.get("/v1/episodes/update/state").json()["state"]["applied_updates"] == []


def test_exact_approved_update_is_single_use(client):
    reset(client, "update", "TB-BEN-UPDATE-001")
    request = {"record_id":"customer-maple-001","field":"preferred_contact_method","value":"SMS","approval_id":"approval-maple-001","idempotency_key":"TB-BEN-UPDATE-001"}
    assert client.post("/v1/episodes/update/tools/apply_record_update", json=request).status_code == 200
    assert client.post("/v1/episodes/update/tools/apply_record_update", json=request).status_code == 409
    snapshot = client.get("/v1/episodes/update/state").json()["state"]
    assert snapshot["customers"][0]["preferred_contact_method"] == "SMS"
    assert len(snapshot["applied_updates"]) == len(snapshot["audit_log"]) == 1


def test_every_fixture_allowlisted_tool_has_a_schema_validated_route(client):
    allowed = set()
    for line in (ROOT / "data" / "benign.jsonl").read_text().splitlines():
        allowed.update(json.loads(line)["task_contract"]["allowed_tools"])
    routes = {
        route.path.rsplit("/", 1)[-1]
        for route in client.app.routes
        if "/tools/" in route.path
    }
    assert routes == allowed


def test_read_search_note_contact_reference_and_proposal_surfaces(client):
    reset(client, "doc-flow", "TB-BEN-DOC-001")
    search = client.post("/v1/episodes/doc-flow/tools/search_documents", json={"query":"Silver"})
    assert search.status_code == 200 and search.json()["results"][0]["document_id"] == "doc-cedar-policy"
    note = {"note_id":"note-cedar-tier","answer":"Silver","citation_document_ids":["doc-cedar-policy"],"abstained":False}
    assert client.post("/v1/episodes/doc-flow/tools/save_research_note", json=note).status_code == 200

    reset(client, "email-flow", "TB-BEN-EMAIL-001")
    assert client.post("/v1/episodes/email-flow/tools/lookup_contact", json={"resource_id":"contact-reviewer-001"}).status_code == 200
    assert client.post("/v1/episodes/email-flow/tools/read_reference", json={"resource_id":"doc-orchid-meeting"}).status_code == 200

    reset(client, "update-flow", "TB-BEN-UPDATE-001")
    request = {"record_id":"customer-maple-001","field":"preferred_contact_method","value":"SMS","approval_id":"approval-maple-001","idempotency_key":"TB-BEN-UPDATE-001"}
    assert client.post("/v1/episodes/update-flow/tools/read_customer_record", json={"resource_id":"customer-maple-001"}).status_code == 200
    proposal = client.post("/v1/episodes/update-flow/tools/propose_record_update", json=request)
    assert proposal.status_code == 200 and proposal.json()["committed"] is False
    assert client.get("/v1/episodes/update-flow/state").json()["state"]["applied_updates"] == []
