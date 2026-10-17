"""Synthetic multi-user fixtures for the live-test API security tests (TB-039): guests, accounts, an operator, an attacker.
Scripted runs use the real runner (seconds, no model, no key)."""
import json, os, re, time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ['TRUSTBENCH_SERVICE_NO_AUTOSTART'] = '1'
from src.service.app import CFG, Service, create_app  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PASSWORD = 'correct horse battery staple 42'
SCRIPTED = {'mode': 'scripted', 'system': 'gateway_capability', 'cases': ['doc-benign', 'doc-attack']}


class User(TestClient):
    """A client of the API. guest() takes an anonymous session, as the website does on first visit."""
    def __init__(self, app, name: str):
        super().__init__(app)
        self.name = name

    def guest(self):
        r = self.post('/api/session')
        assert r.status_code == 201, r.text
        self.headers['Authorization'] = 'Bearer ' + r.json()['token']
        return self

    def use(self, token: str):
        self.headers['Authorization'] = 'Bearer ' + token
        return self

    def run(self, body=SCRIPTED, wait=True):
        r = self.post('/api/runs', json=body)
        assert r.status_code == 202, r.text
        job = r.json()
        while wait and job['status'] in ('queued', 'running'):
            time.sleep(0.4)
            job = self.get(f"/api/runs/{job['id']}").json()
        return job


class World:
    def __init__(self, tmp_path):
        self.data = tmp_path / 'service'
        self.service = Service(data_dir=self.data)
        self.app = create_app(self.service)

    def user(self, name: str) -> User:
        return User(self.app, name)

    def outbox(self) -> list[dict]:
        box = self.data / CFG['accounts']['mail']['outbox_dir']
        return [json.loads(p.read_text()) for p in sorted(box.glob('*.json'))] if box.exists() else []

    def link_token(self, to: str, purpose: str) -> str:
        marker = {'verify': '/account/verify#token=', 'reset': '/account/reset#token='}[purpose]
        for m in reversed(self.outbox()):
            if m['to'] == to and marker in m['body']:
                return re.search(re.escape(marker) + r'([A-Za-z0-9_-]+)', m['body']).group(1)
        raise AssertionError(f'no {purpose} mail to {to}')

    def account(self, name: str, email: str, password: str = PASSWORD) -> User:
        """Sign up, follow the emailed verification link, and come back signed in (the real flow)."""
        u = self.user(name).guest()
        assert u.post('/api/auth/signup', json={'email': email, 'password': password}).status_code == 201
        r = u.post('/api/auth/verify', json={'token': self.link_token(email, 'verify')})
        assert r.status_code == 200, r.text
        return u.use(r.json()['token'])

    def files(self) -> list[Path]:
        return [p for p in self.data.rglob('*') if p.is_file()]


@pytest.fixture()
def world(tmp_path):
    return World(tmp_path)
