"""Conservative transport metadata, never an authorization credential."""
import hashlib
import json
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class Provenance(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, strict=True)
    source_ids: tuple[str, ...] = ()
    trust: Literal['untrusted', 'unknown']
    transformations: tuple[str, ...] = ()
    reason: str | None = None

    @model_validator(mode='after')
    def validate_sources(self):
        if self.trust == 'untrusted' and not self.source_ids:
            raise ValueError('known provenance requires a source')
        if any(not s.strip() for s in self.source_ids):
            raise ValueError('empty source')
        if self.trust == 'unknown' and not self.reason:
            raise ValueError('unknown provenance requires a reason')
        return self

class Envelope(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, strict=True)
    version: Literal['tb020.1'] = 'tb020.1'
    payload: Any
    provenance: Provenance

def unknown(payload, reason):
    return Envelope(payload=payload, provenance=Provenance(trust='unknown', reason=reason))

def decode(value):
    try:
        # JSON round trip provides strict JSON validation for tuple fields.
        return Envelope.model_validate_json(json.dumps(value))
    except (ValueError, TypeError):
        return unknown(value, 'missing_or_invalid_provenance')

def wrap(payload, source_ids):
    ids = tuple(sorted(set(source_ids)))
    return (Envelope(payload=payload, provenance=Provenance(trust='untrusted', source_ids=ids))
            if ids else unknown(payload, 'no_source_ids'))

def transform(inputs: list[Envelope], payload, operation: str):
    if not operation.strip():
        raise ValueError('transformation name required')
    sources = tuple(sorted({s for e in inputs for s in e.provenance.source_ids}))
    history = tuple(dict.fromkeys(t for e in inputs for t in e.provenance.transformations)) + (operation,)
    missing = not inputs or any(e.provenance.trust == 'unknown' for e in inputs)
    return Envelope(payload=payload, provenance=Provenance(
        trust='unknown' if missing else 'untrusted', source_ids=sources,
        transformations=history, reason='unknown_input_lineage' if missing else None))

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
