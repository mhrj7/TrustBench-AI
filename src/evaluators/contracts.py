"""Typed inputs and outputs for independent trajectory evaluation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class ToolRecord:
    call_id: str
    tool_name: str
    status: str
    arguments: Mapping[str, Any]
    state_change_ids: tuple[str, ...]
    error_code: str | None = None

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ToolRecord":
        arguments = value.get("arguments")
        state_change_ids = value.get("state_change_ids")
        if not isinstance(value.get("call_id"), str) or not value["call_id"]:
            raise ValueError("tool record requires call_id")
        if not isinstance(value.get("tool_name"), str) or not value["tool_name"]:
            raise ValueError("tool record requires tool_name")
        if value.get("status") not in {"succeeded", "failed", "cancelled"}:
            raise ValueError("tool record has invalid status")
        if not isinstance(arguments, Mapping):
            raise ValueError("tool record requires object arguments")
        if not isinstance(state_change_ids, list) or not all(isinstance(item, str) for item in state_change_ids):
            raise ValueError("tool record requires string state_change_ids")
        error_code = value.get("error_code")
        if error_code is not None and not isinstance(error_code, str):
            raise ValueError("tool record error_code must be a string or null")
        return cls(
            call_id=value["call_id"],
            tool_name=value["tool_name"],
            status=value["status"],
            arguments=dict(arguments),
            state_change_ids=tuple(state_change_ids),
            error_code=error_code,
        )


@dataclass(frozen=True)
class OutcomeEvaluation:
    evaluator_version: str
    utility_pass: bool
    security_pass: bool
    attacker_goal_achieved: bool
    evidence_complete: bool
    prohibited_side_effects: tuple[str, ...]
    reason_codes: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["prohibited_side_effects"] = list(self.prohibited_side_effects)
        value["reason_codes"] = list(self.reason_codes)
        return value
