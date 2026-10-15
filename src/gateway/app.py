"""Agent-facing gateway; raw ASGI tools have no listener in this deployment."""
import asyncio
import json
import secrets
from dataclasses import dataclass
from typing import Any
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx2 as httpx
from .provenance import digest, wrap
from pydantic import ValidationError
from src.policy.capabilities import Capability, POLICY
from src.policy.approvals import ApprovalStore, execution_context
from src.policy.flow import FlowGuard

@dataclass(frozen=True)
class Binding:
    episode_id: str
    allowed_tools: frozenset[str]
    capability: Capability
    flow: FlowGuard | None = None

class Gateway:
    def __init__(self, backend, audit_path=None, flow_check=False):
        self.flow_check = flow_check
        self.app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        self._audit_path = audit_path
        self._flushed = 0
        self._backend = backend
        self.store = backend.state.episode_store
        self.approvals = ApprovalStore(self.store)
        self._bindings: dict[str, Binding] = {}
        self.audit: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()

        @self.app.middleware('http')
        async def flush_policy_decisions(request: Request, call_next):
            # Host-only JSONL trace of policy decisions; contains argument hashes, never tokens.
            response = await call_next(request)
            if self._audit_path is not None:
                with open(self._audit_path, 'a', encoding='utf-8') as sink:
                    while self._flushed < len(self.audit):
                        sink.write(json.dumps({'seq': self._flushed, **self.audit[self._flushed]}, sort_keys=True) + '\n')
                        self._flushed += 1
            return response

        @self.app.post('/v1/episodes/{episode_id}/tools/{tool_name}')
        async def dispatch(episode_id: str, tool_name: str, request: Request):
            # A model supplies only arguments. Host-issued capability is never in prompt/tool schema.
            token = request.headers.get('authorization', '').removeprefix('Bearer ')
            binding = self._bindings.get(token)
            reason = ('missing_or_invalid_session' if binding is None else
                      'episode_mismatch' if binding.episode_id != episode_id else
                      'tool_not_allowed' if tool_name not in binding.allowed_tools else None)
            if reason:
                self.audit.append({'episode_id': episode_id, 'tool': tool_name, 'decision': 'deny', 'reason': reason})
                return JSONResponse(status_code=403, content={'detail': reason})
            if self.store.snapshot(episode_id)['generation'] != binding.capability.generation:
                return JSONResponse(status_code=403, content={'detail':'stale_capability'})
            try:
                arguments = await request.json()
                if not isinstance(arguments, dict):
                    raise ValueError('arguments must be an object')
            except (ValueError, TypeError):
                return JSONResponse(status_code=422, content={'detail': 'invalid_arguments'})
            try:
                arguments = binding.capability.validate(tool_name, arguments)
            except (ValueError, ValidationError) as error:
                reason = 'invalid_arguments' if isinstance(error, ValidationError) else str(error)
                self.audit.append({'episode_id':episode_id,'tool':tool_name,'decision':'deny','reason':reason})
                return JSONResponse(status_code=422 if isinstance(error, ValidationError) else 403, content={'detail':reason})
            if binding.flow is not None:
                violation = binding.flow.check(tool_name, arguments, self.store.snapshot(episode_id)['state'])
                if violation is not None:
                    reason = f"untrusted_flow:{violation['rule']}"
                    self.audit.append({'episode_id':episode_id,'tool':tool_name,'decision':'deny','reason':reason,'flow':violation})
                    return JSONResponse(status_code=403, content={'detail':reason})
            approval_id = None
            if tool_name in POLICY['approval_required_tools']:
                try:
                    approval = self.approvals.request(binding.capability, tool_name, arguments)
                except ValueError as error:
                    return JSONResponse(status_code=403, content={'detail':str(error)})
                approval_id = approval['request_id']
                if approval['status'] == 'pending':
                    self.audit.append({'episode_id':episode_id,'tool':tool_name,'decision':'require_approval','request_id':approval_id})
                    return JSONResponse(status_code=409, content={'detail':'approval_required','request_id':approval_id})
            # Log decision before dispatch; never forward incoming headers/URLs to raw tools.
            record = {'episode_id': episode_id, 'tool': tool_name, 'decision': 'allow',
                      'arguments_sha256': digest(arguments), 'executed': False}
            self.audit.append(record)
            async with self._lock:
                authorization = {'capability':binding.capability,'arguments':arguments,'approval_request_id':approval_id}
                context = execution_context.set(authorization)
                try:
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self._backend), base_url='http://internal') as client:
                        response = await client.post(f'/v1/episodes/{episode_id}/tools/{tool_name}', json=arguments)
                finally:
                    execution_context.reset(context)
            record.update(status=response.status_code, executed=response.is_success and not authorization.get('replayed', False),
                          replayed=authorization.get('replayed', False))
            try:
                body = response.json()
                json.dumps(body, allow_nan=False)
            except (ValueError, TypeError):
                # Malformed tool output fails closed: the raw bytes are never relayed.
                record.update(malformed_output=True)
                return JSONResponse(status_code=502, content={'detail': 'malformed_tool_output'})
            if not response.is_success:
                if not isinstance(body, dict):
                    record.update(malformed_output=True)
                    return JSONResponse(status_code=502, content={'detail': 'malformed_tool_output'})
                return JSONResponse(status_code=response.status_code, content=body)
            ps = POLICY['provenance_sources']
            sources = [ps['operation_source_template'].format(episode=episode_id, tool=tool_name)]
            if isinstance(body, dict):
                if isinstance(body.get(ps['id_field']), str):
                    sources.append(ps['source_prefix'] + body[ps['id_field']])
                for list_field in ps['list_fields']:
                    items = body.get(list_field)
                    for result in (items if isinstance(items, list) else []):
                        if isinstance(result, dict) and isinstance(result.get(ps['id_field']), str):
                            sources.append(ps['source_prefix'] + result[ps['id_field']])
            envelope = wrap(body, sources).model_dump(mode='json')
            record['provenance'] = envelope['provenance']
            if binding.flow is not None:
                binding.flow.observe(envelope)
            return envelope

    def bind(self, episode_id: str, allowed_tools: list[str], user_id: str | None = None) -> str:
        """Trusted host setup only; no HTTP registration/reset endpoint exists."""
        import re
        if not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', episode_id):
            raise ValueError('invalid episode')
        if any(not re.fullmatch(r'[a-z_]+', name) for name in allowed_tools):
            raise ValueError('invalid tool')
        token = secrets.token_urlsafe(32)
        capability = Capability.issue(self.store, episode_id, allowed_tools, user_id)
        flow = FlowGuard(POLICY, capability.contract_json) if self.flow_check else None
        self._bindings[token] = Binding(episode_id, frozenset(allowed_tools), capability, flow)
        return token

    def revoke(self, token: str):
        self._bindings.pop(token, None)
