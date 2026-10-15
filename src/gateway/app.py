"""Agent-facing gateway; raw ASGI tools have no listener in this deployment."""
import asyncio
import secrets
from dataclasses import dataclass
from typing import Any
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx2 as httpx
from .provenance import digest, wrap

@dataclass(frozen=True)
class Binding:
    episode_id: str
    allowed_tools: frozenset[str]

class Gateway:
    def __init__(self, backend):
        self.app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        self._backend = backend
        self._bindings: dict[str, Binding] = {}
        self.audit: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()

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
            try:
                arguments = await request.json()
                if not isinstance(arguments, dict):
                    raise ValueError('arguments must be an object')
            except (ValueError, TypeError):
                return JSONResponse(status_code=422, content={'detail': 'invalid_arguments'})
            # Log decision before dispatch; never forward incoming headers/URLs to raw tools.
            record = {'episode_id': episode_id, 'tool': tool_name, 'decision': 'allow',
                      'arguments_sha256': digest(arguments), 'executed': False}
            self.audit.append(record)
            async with self._lock:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self._backend), base_url='http://internal') as client:
                    response = await client.post(f'/v1/episodes/{episode_id}/tools/{tool_name}', json=arguments)
            record.update(status=response.status_code, executed=response.is_success)
            body = response.json()
            if not response.is_success:
                return JSONResponse(status_code=response.status_code, content=body)
            sources = [f'episode:{episode_id}:tool:{tool_name}']
            if isinstance(body, dict):
                if isinstance(body.get('document_id'), str):
                    sources.append('document:' + body['document_id'])
                for result in body.get('results', []):
                    if isinstance(result, dict) and isinstance(result.get('document_id'), str):
                        sources.append('document:' + result['document_id'])
            envelope = wrap(body, sources).model_dump(mode='json')
            record['provenance'] = envelope['provenance']
            return envelope

    def bind(self, episode_id: str, allowed_tools: list[str]) -> str:
        """Trusted host setup only; no HTTP registration/reset endpoint exists."""
        import re
        if not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', episode_id):
            raise ValueError('invalid episode')
        if any(not re.fullmatch(r'[a-z_]+', name) for name in allowed_tools):
            raise ValueError('invalid tool')
        token = secrets.token_urlsafe(32)
        self._bindings[token] = Binding(episode_id, frozenset(allowed_tools))
        return token

    def revoke(self, token: str):
        self._bindings.pop(token, None)
