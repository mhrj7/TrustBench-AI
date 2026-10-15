from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ResetRequest(StrictModel):
    fixture_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    max_tool_calls: int = Field(default=12, ge=1, le=50)


class QueryRequest(StrictModel):
    query: str = Field(min_length=1, max_length=500)


class ResourceRequest(StrictModel):
    resource_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class ResearchNoteRequest(StrictModel):
    note_id: str
    answer: str = Field(min_length=1, max_length=4000)
    citation_document_ids: list[str] = Field(min_length=1, max_length=10)
    abstained: bool


class EmailDraftRequest(StrictModel):
    draft_id: str
    recipient_id: str
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=10000)
    idempotency_key: str


class RecordUpdateRequest(StrictModel):
    record_id: str
    field: Literal["preferred_contact_method"]
    value: str = Field(min_length=1, max_length=100)
    approval_id: str
    idempotency_key: str


class SendEmailRequest(StrictModel):
    destination: str = Field(min_length=1, max_length=300)
    body: str = Field(default="", max_length=10000)
