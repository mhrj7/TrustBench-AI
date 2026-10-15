import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException

from .schemas import SendEmailRequest, EmailDraftRequest, QueryRequest, RecordUpdateRequest, ResearchNoteRequest, ResetRequest, ResourceRequest
from .store import EpisodeStore, ToolError, exact

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = Path(os.environ.get("TRUSTBENCH_FIXTURE_PATH", ROOT / "data" / "benign.jsonl"))
DATABASE_PATH = Path(os.environ.get("TRUSTBENCH_TOOL_DB", ROOT / ".tool-state" / "episodes.sqlite"))
# "contract" (default, TB-014): service-side task-contract checks. "permissive": the protocol's uncontrolled
# baseline backend: schema validity, tenant scoping, referential integrity and synthetic-only effects, but no
# task-contract allowlist, exact-argument or approval enforcement. Attacks can therefore commit synthetic effects.
TOOL_MODE = os.environ.get("TRUSTBENCH_TOOL_MODE", "contract")
if TOOL_MODE not in ("contract", "permissive"):
    raise ValueError("TRUSTBENCH_TOOL_MODE must be 'contract' or 'permissive'")
PERMISSIVE = TOOL_MODE == "permissive"
store = EpisodeStore(FIXTURE_PATH, DATABASE_PATH)
store.enforce_contract_allowlist = not PERMISSIVE
app = FastAPI(title="TrustBench Synthetic Tool Service", version="1.0.0", docs_url=None, redoc_url=None)
app.state.episode_store = store


@app.exception_handler(ToolError)
async def tool_error_handler(_request, error: ToolError):
    return __import__("fastapi").responses.JSONResponse(status_code=error.status, content={"detail": error.detail})


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "synthetic_only": True, "external_egress_required": False}


@app.post("/v1/episodes/{episode_id}/reset")
def reset(episode_id: str, request: ResetRequest) -> dict[str, Any]:
    return store.reset(episode_id, request.fixture_id, request.max_tool_calls)


@app.post("/v1/episodes/{episode_id}/tools/search_documents")
def search_documents(episode_id: str, request: QueryRequest) -> dict[str, Any]:
    def operation(contract, state, tenant_id):
        allowed = set(contract.get("allowed_document_ids", contract.get("reference_document_ids", [])))
        query = request.query.casefold()
        results = [
            {"document_id": item["document_id"], "snippet": item["content"][:500]}
            for item in state["documents"]
            if item["tenant_id"] == tenant_id and (PERMISSIVE or item["document_id"] in allowed) and query in item["content"].casefold()
        ]
        return {"results": results}
    return store.execute(episode_id, "search_documents", operation)


def _read_document(episode_id: str, request: ResourceRequest, tool_name: str) -> dict[str, Any]:
    def operation(contract, state, tenant_id):
        allowed = set(contract.get("allowed_document_ids", contract.get("reference_document_ids", [])))
        if not PERMISSIVE and request.resource_id not in allowed:
            raise ToolError(403, "document_not_allowed_by_contract")
        return exact(state["documents"], "document_id", request.resource_id, tenant_id)
    return store.execute(episode_id, tool_name, operation)


@app.post("/v1/episodes/{episode_id}/tools/read_document")
def read_document(episode_id: str, request: ResourceRequest) -> dict[str, Any]:
    return _read_document(episode_id, request, "read_document")


@app.post("/v1/episodes/{episode_id}/tools/read_reference")
def read_reference(episode_id: str, request: ResourceRequest) -> dict[str, Any]:
    return _read_document(episode_id, request, "read_reference")


@app.post("/v1/episodes/{episode_id}/tools/lookup_contact")
def lookup_contact(episode_id: str, request: ResourceRequest) -> dict[str, Any]:
    def operation(contract, state, tenant_id):
        if not PERMISSIVE and request.resource_id != contract.get("recipient_id"):
            raise ToolError(403, "contact_not_allowed_by_contract")
        return exact(state["contacts"], "contact_id", request.resource_id, tenant_id)
    return store.execute(episode_id, "lookup_contact", operation)


@app.post("/v1/episodes/{episode_id}/tools/read_customer_record")
def read_customer_record(episode_id: str, request: ResourceRequest) -> dict[str, Any]:
    def operation(contract, state, tenant_id):
        if not PERMISSIVE and request.resource_id != contract.get("record_id"):
            raise ToolError(403, "record_not_allowed_by_contract")
        return exact(state["customers"], "record_id", request.resource_id, tenant_id)
    return store.execute(episode_id, "read_customer_record", operation)


@app.post("/v1/episodes/{episode_id}/tools/propose_record_update")
def propose_record_update(episode_id: str, request: RecordUpdateRequest) -> dict[str, Any]:
    def operation(contract, state, tenant_id):
        expected = (contract.get("record_id"), contract.get("field"), contract.get("value"), contract.get("approval_id"), contract.get("idempotency_key"))
        actual = (request.record_id, request.field, request.value, request.approval_id, request.idempotency_key)
        if not PERMISSIVE and actual != expected:
            raise ToolError(403, "proposal_arguments_not_allowed_by_contract")
        customer = exact(state["customers"], "record_id", request.record_id, tenant_id)
        if request.field not in customer["allowlisted_fields"]:
            raise ToolError(403, "proposal_field_not_allowed")
        return {"approved_arguments": request.model_dump(), "current_value": customer[request.field], "committed": False}
    return store.execute(episode_id, "propose_record_update", operation)


@app.post("/v1/episodes/{episode_id}/tools/save_research_note")
def save_research_note(episode_id: str, request: ResearchNoteRequest) -> dict[str, Any]:
    def operation(contract, state, _tenant_id):
        if not PERMISSIVE and (request.note_id != contract.get("allowed_note_id") or set(request.citation_document_ids) - set(contract.get("allowed_document_ids", []))):
            raise ToolError(403, "research_note_not_allowed_by_contract")
        note = request.model_dump()
        state["research_notes"] = [note]
        return note
    return store.execute(episode_id, "save_research_note", operation)


@app.post("/v1/episodes/{episode_id}/tools/create_email_draft")
def create_email_draft(episode_id: str, request: EmailDraftRequest) -> dict[str, Any]:
    def operation(contract, state, _tenant_id):
        expected = (contract.get("draft_id"), contract.get("recipient_id"), contract.get("subject"), contract.get("idempotency_key"))
        actual = (request.draft_id, request.recipient_id, request.subject, request.idempotency_key)
        if not PERMISSIVE and (actual != expected or not all(fragment in request.body for fragment in contract.get("required_body_fragments", []))):
            raise ToolError(403, "draft_arguments_not_allowed_by_contract")
        if PERMISSIVE:
            exact(state["contacts"], "contact_id", request.recipient_id, _tenant_id)  # referential integrity only
        if state["email_drafts"]:
            raise ToolError(409, "draft_already_exists")
        draft = request.model_dump()
        state["email_drafts"].append(draft)
        return draft
    return store.execute(episode_id, "create_email_draft", operation)


@app.post("/v1/episodes/{episode_id}/tools/apply_record_update")
def apply_record_update(episode_id: str, request: RecordUpdateRequest) -> dict[str, Any]:
    def operation(contract, state, tenant_id):
        expected = (contract.get("record_id"), contract.get("field"), contract.get("value"), contract.get("approval_id"), contract.get("idempotency_key"))
        actual = (request.record_id, request.field, request.value, request.approval_id, request.idempotency_key)
        if not PERMISSIVE:
            if actual != expected:
                raise ToolError(403, "update_arguments_not_allowed_by_contract")
            approval = exact(state["approvals"], "approval_id", request.approval_id, tenant_id)
            bound = (approval["record_id"], approval["field"], approval["value"], approval["idempotency_key"])
            if bound != (request.record_id, request.field, request.value, request.idempotency_key):
                raise ToolError(403, "approval_arguments_do_not_match")
            if state["applied_updates"]:
                raise ToolError(409, "single_use_approval_already_consumed")
        customer = next((row for row in state["customers"] if row["record_id"] == request.record_id and row["tenant_id"] == tenant_id), None)
        if customer is None or request.field not in customer["allowlisted_fields"]:
            raise ToolError(403, "record_or_field_not_allowed")
        previous = customer[request.field]
        customer[request.field] = request.value
        effect = {**request.model_dump(), "effect_count": 1}
        state["applied_updates"].append(effect)
        state["audit_log"].append({"record_id": request.record_id, "field": request.field, "previous_value": previous, "new_value": request.value, "approval_id": request.approval_id, "idempotency_key": request.idempotency_key, "effect_count": 1})
        return effect
    return store.execute(episode_id, "apply_record_update", operation)


@app.post("/v1/episodes/{episode_id}/tools/send_external_email")
def send_external_email(episode_id: str, request: SendEmailRequest) -> dict[str, Any]:
    """Synthetic sink only: records the attempted send in state, never contacts anything. Not in any task contract."""
    def operation(contract, state, _tenant_id):
        message = request.model_dump()
        state["sent_emails"].append(message)
        return message
    return store.execute(episode_id, "send_external_email", operation)


if os.environ.get("TRUSTBENCH_TEST_MODE") == "1":
    @app.get("/v1/episodes/{episode_id}/state")
    def state(episode_id: str) -> dict[str, Any]:
        return store.snapshot(episode_id)
