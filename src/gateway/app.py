"""Agent-facing gateway; raw ASGI tools have no listener in this deployment."""
import asyncio
import json
import os
import time
import secrets
from dataclasses import dataclass
from typing import Any
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx2 as httpx
from .provenance import digest, sign, wrap
from pydantic import ValidationError
from src.policy.capabilities import Capability, POLICY, SCHEMAS
from src.policy.approvals import ApprovalStore, execution_context
from src.policy.flow import FlowGuard

@dataclass(frozen=True)
class Binding:
    episode_id: str
    allowed_tools: frozenset[str]
    capability: Capability
    flow: FlowGuard | None = None
    signing_key: bytes = b''

# TB-036 (A-027) ablation switches. The default (nothing disabled) is the full gateway; a layer is only ever disabled by a
# named ablation variant in configs/ablations.yaml. Contract scoping is part of the capability check and needs the allowlist.
ABLATABLE_LAYERS = frozenset({'tool_allowlist', 'contract_scope', 'approval'})


class Gateway:
    def __init__(self, backend, audit_path=None, flow_check=False, session_db=None, session_ttl_s=None, disabled_layers=()):
        self.disabled = frozenset(disabled_layers)
        if not self.disabled <= ABLATABLE_LAYERS:
            raise ValueError(f'unknown gateway layers: {sorted(self.disabled - ABLATABLE_LAYERS)}')
        if 'tool_allowlist' in self.disabled and 'contract_scope' not in self.disabled:
            raise ValueError('contract scoping cannot run without the tool allowlist')
        self.flow_check = flow_check
        self._session_db = session_db
        self._session_ttl_s = session_ttl_s
        if session_db is not None:
            self._init_session_db()
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
            try:
                self.flush_audit()
            except OSError:
                # The decision was already persisted write-ahead (record_intent) before any effect; a failed final flush
                # loses only the outcome fields, and the next request retries the flush.
                pass
            return response

        @self.app.post('/v1/episodes/{episode_id}/tools/{tool_name}')
        async def dispatch(episode_id: str, tool_name: str, request: Request):
            # A model supplies only arguments. Host-issued capability is never in prompt/tool schema.
            # TB-027: decision timing for policy spans (wall-clock arrival, time to decision, time in the tool backend).
            arrived_ms, t0 = time.time() * 1000, time.perf_counter()
            def stamp(entry):
                entry.update(started_at_ms=round(arrived_ms, 3), policy_ms=round((time.perf_counter() - t0) * 1000, 3))
                return entry
            token = request.headers.get('authorization', '').removeprefix('Bearer ')
            binding = self._bindings.get(token) or self._load_session(token)
            reason = ('missing_or_invalid_session' if binding is None else
                      'episode_mismatch' if binding.episode_id != episode_id else
                      'tool_not_allowed' if 'tool_allowlist' not in self.disabled and tool_name not in binding.allowed_tools else None)
            if reason:
                self.audit.append(stamp({'episode_id': episode_id, 'tool': tool_name, 'decision': 'deny', 'reason': reason}))
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
                if 'contract_scope' in self.disabled:  # ablation: strict argument schemas only
                    if tool_name not in SCHEMAS:
                        raise ValueError('operation_denied')
                    arguments = SCHEMAS[tool_name].model_validate(arguments, strict=True).model_dump()
                else:
                    arguments = binding.capability.validate(tool_name, arguments)
            except (ValueError, ValidationError) as error:
                reason = 'invalid_arguments' if isinstance(error, ValidationError) else str(error)
                self.audit.append(stamp({'episode_id':episode_id,'tool':tool_name,'decision':'deny','reason':reason}))
                return JSONResponse(status_code=422 if isinstance(error, ValidationError) else 403, content={'detail':reason})
            if binding.flow is not None:
                violation = binding.flow.check(tool_name, arguments, self.store.snapshot(episode_id)['state'])
                if violation is not None:
                    reason = f"untrusted_flow:{violation['rule']}"
                    self.audit.append(stamp({'episode_id':episode_id,'tool':tool_name,'decision':'deny','reason':reason,'flow':violation}))
                    return JSONResponse(status_code=403, content={'detail':reason})
            approval_id = None
            if tool_name in POLICY['approval_required_tools'] and 'approval' not in self.disabled:
                try:
                    approval = self.approvals.request(binding.capability, tool_name, arguments)
                except ValueError as error:
                    return JSONResponse(status_code=403, content={'detail':str(error)})
                approval_id = approval['request_id']
                if approval['status'] == 'pending':
                    self.audit.append(stamp({'episode_id':episode_id,'tool':tool_name,'decision':'require_approval','request_id':approval_id}))
                    return JSONResponse(status_code=409, content={'detail':'approval_required','request_id':approval_id})
            # Log decision before dispatch; never forward incoming headers/URLs to raw tools.
            record = {'episode_id': episode_id, 'tool': tool_name, 'decision': 'allow',
                      'arguments_sha256': digest(arguments), 'executed': False}
            self.audit.append(stamp(record))
            if not self.record_intent(record):
                record.update(decision='deny', reason='audit_unavailable')
                return JSONResponse(status_code=503, content={'detail': 'audit_unavailable'})
            backend_t0 = time.perf_counter()
            async with self._lock:
                authorization = {'capability':binding.capability,'arguments':arguments,'approval_request_id':approval_id}
                # An ablated gateway runs the backend without its capability context (as the baseline service runs), so the
                # backend does not re-impose the layers this variant switched off.
                context = execution_context.set(None if self.disabled else authorization)
                try:
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self._backend), base_url='http://internal') as client:
                        response = await client.post(f'/v1/episodes/{episode_id}/tools/{tool_name}', json=arguments)
                except Exception as error:  # noqa: BLE001 - TB-040: a crashed tool is an explicit failure, never a silent success
                    record.update(backend_ms=round((time.perf_counter() - backend_t0) * 1000, 3), status=502, executed=False,
                                  backend_error=type(error).__name__)
                    return JSONResponse(status_code=502, content={'detail': 'tool_backend_error'})
                finally:
                    execution_context.reset(context)
            record.update(backend_ms=round((time.perf_counter() - backend_t0) * 1000, 3))
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
            envelope = sign(wrap(body, sources).model_dump(mode='json'), binding.signing_key)
            record['provenance'] = envelope['provenance']
            if binding.flow is not None:
                binding.flow.observe(envelope)
            return envelope

    def flush_audit(self):
        if self._audit_path is None:
            return
        with open(self._audit_path, 'a', encoding='utf-8') as sink:
            while self._flushed < len(self.audit):
                sink.write(json.dumps({'seq': self._flushed, **self.audit[self._flushed]}, sort_keys=True) + '\n')
                self._flushed += 1

    def record_intent(self, record: dict) -> bool:
        """TB-040 write-ahead audit: an allow decision is made durable before the tool runs. With no audit store configured
        there is nothing to fail; otherwise a failed write means the call must not run (fail closed)."""
        if self._audit_path is None:
            return True
        try:
            with open(f'{self._audit_path}.intent', 'a', encoding='utf-8') as sink:
                sink.write(json.dumps({'seq': len(self.audit) - 1, **record}, sort_keys=True) + '\n')
                sink.flush()
                os.fsync(sink.fileno())
            return True
        except OSError:
            return False

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
        binding = Binding(episode_id, frozenset(allowed_tools), capability, flow, secrets.token_bytes(32))
        self._bindings[token] = binding
        self._persist_session(token, binding)
        return token

    # ---- durable sessions (TB-026) ----
    def _connect_sessions(self):
        import sqlite3
        return sqlite3.connect(self._session_db, timeout=10)

    def _init_session_db(self):
        import os, time
        new = not os.path.exists(self._session_db)
        with self._connect_sessions() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS gateway_sessions (token_sha256 TEXT PRIMARY KEY, episode_id TEXT NOT NULL,
                allowed_tools_json TEXT NOT NULL, capability_json TEXT NOT NULL, signing_key_hex TEXT NOT NULL, flow INTEGER NOT NULL,
                expires_at REAL NOT NULL)''')
            db.execute('DELETE FROM gateway_sessions WHERE expires_at < ?', (time.time(),))  # retention: expired sessions are purged
        if new:
            os.chmod(self._session_db, 0o600)  # owner-only: the file holds signing keys

    def _persist_session(self, token, binding):
        if self._session_db is None:
            return
        import hashlib, time
        cap = binding.capability
        capability = json.dumps({'episode_id': cap.episode_id, 'generation': cap.generation, 'user_id': cap.user_id, 'tenant_id': cap.tenant_id,
                                 'allowed_tools': sorted(cap.allowed_tools), 'contract_json': cap.contract_json})
        with self._connect_sessions() as db:
            db.execute('INSERT OR REPLACE INTO gateway_sessions VALUES (?,?,?,?,?,?,?)',
                       (hashlib.sha256(token.encode()).hexdigest(), binding.episode_id, json.dumps(sorted(binding.allowed_tools)), capability,
                        binding.signing_key.hex(), 1 if binding.flow is not None else 0, time.time() + self._session_ttl_s))

    def _load_session(self, token):
        """Restores a session after a gateway restart. Only a hash of the bearer token is stored."""
        if self._session_db is None or not token:
            return None
        import hashlib, time
        with self._connect_sessions() as db:
            row = db.execute('SELECT episode_id, allowed_tools_json, capability_json, signing_key_hex, flow FROM gateway_sessions WHERE token_sha256 = ? AND expires_at >= ?',
                             (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        if row is None:
            return None
        c = json.loads(row[2])
        capability = Capability(c['episode_id'], c['generation'], c['user_id'], c['tenant_id'], frozenset(c['allowed_tools']), c['contract_json'])
        binding = Binding(row[0], frozenset(json.loads(row[1])), capability, FlowGuard(POLICY, capability.contract_json) if row[4] else None, bytes.fromhex(row[3]))
        self._bindings[token] = binding
        return binding

    def signing_key(self, token: str) -> str:
        """Trusted host only: the per-session envelope key handed to the agent adapter with the session token."""
        return self._bindings[token].signing_key.hex()

    def revoke(self, token: str):
        self._bindings.pop(token, None)
        if self._session_db is not None:
            import hashlib
            with self._connect_sessions() as db:
                db.execute('DELETE FROM gateway_sessions WHERE token_sha256 = ?', (hashlib.sha256(token.encode()).hexdigest(),))
