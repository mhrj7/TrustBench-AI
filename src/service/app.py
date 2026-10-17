"""TrustBench live-test service: the API behind the website's Live page and `trustbench remote`.

Three modes (configs/live-service.yaml): scripted (no model, no key), hosted (the project's free-tier key, read from the
server environment only, budget-capped) and own_key (the visitor's free-tier key, held in memory for that run, passed to
the runner in its environment, never written, logged or returned). Each job runs scripts/run-arm-smoke.mjs on the
development suite in its own directory; sealed holdouts are excluded by the runner and never offered. Before a job's
results are served, every file it produced is scanned for the keys it could have seen; a match deletes the artifacts.

TB-039: every run belongs to an anonymous session (src/service/sessions.py) and is visible only to it, to a holder of its
revocable share token, or to the operator; owners can delete a run or their whole session with every artifact; a sweep
deletes expired runs and sessions. Secrets come from src/service/secrets.py, which also redacts them from logs.

Run locally:  .venv-tools/bin/python -m uvicorn src.service.app:app --port 8080"""
import importlib.util, json, os, queue, re, secrets, shutil, subprocess, sys, threading, time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from src.service import secrets as sec
from src.service.accounts import EMAIL, Accounts
from src.service.mail import Mailer
from src.service.sessions import SessionStore, digest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
CFG = json.loads((ROOT / 'configs/live-service.yaml').read_text())
MATRIX = json.loads((ROOT / 'configs/live-matrix.yaml').read_text())
PROVIDERS = json.loads((ROOT / 'configs/providers.yaml').read_text())['providers']
HC = json.loads((ROOT / 'configs/frozen/holdout-config.json').read_text())
WORKFLOW = {f['fixture_id']: f['workflow'] for f in map(json.loads, filter(str.strip, (ROOT / 'data/benign.jsonl').read_text().splitlines()))}
SUITE = json.loads((ROOT / CFG['suite']).read_text())


def _load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / f'{name}.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


AUTH = CFG['auth']
ACC = CFG['accounts']
ADMIN = '__operator__'


def stop_group(proc: subprocess.Popen, grace_s: float = 10) -> None:
    """Stop a run's whole process group (the runner and every service it started): SIGTERM, then SIGKILL after the grace
    period. Children that outlive the runner are reaped too, so a cancelled run leaves no process behind (TB-040)."""
    import signal
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            return
        deadline = time.time() + grace_s
        while time.time() < deadline:
            proc.poll()
            try:
                os.killpg(pgid, 0)
            except (ProcessLookupError, PermissionError):  # macOS reports EPERM once only exited (zombie) members remain
                return
            time.sleep(0.1)


def env_value(name: Optional[str]) -> Optional[str]:
    """A server-side secret (src/service/secrets.py: env, mounted secret file, .env); never returned to a client."""
    return sec.get(name)


class Credentials(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256, repr=False)


class EmailOnly(BaseModel):
    email: str = Field(max_length=254)


class TokenOnly(BaseModel):
    token: str = Field(max_length=256, repr=False)


class Reset(BaseModel):
    token: str = Field(max_length=256, repr=False)
    password: str = Field(max_length=256, repr=False)


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=256, repr=False)
    new_password: str = Field(max_length=256, repr=False)


class PasswordOnly(BaseModel):
    password: str = Field(max_length=256, repr=False)


class RunRequest(BaseModel):
    mode: str
    system: str
    rendering: Optional[str] = None
    model: Optional[str] = None
    cases: list[str] = Field(default_factory=list, max_length=64)
    repetitions: int = Field(1, ge=1, le=10)
    agent: str = 'trustbench_baseline'
    api_key: Optional[str] = Field(None, repr=False)


class Service:
    def __init__(self, data_dir: Optional[Path] = None, runner: Optional[list[str]] = None, start_workers: bool = True):
        self.data = Path(data_dir or os.environ.get(CFG['data_dir_env']) or ROOT / CFG['default_data_dir'])
        (self.data / 'jobs').mkdir(parents=True, exist_ok=True)
        self.runner = runner or ['node', '--experimental-strip-types', '--no-warnings', 'scripts/run-arm-smoke.mjs']
        self.jobs: dict[str, dict[str, Any]] = {}
        self.secrets: dict[str, str] = {}  # job id -> visitor key, in memory only, removed when the run ends
        self.lock = threading.Lock()
        self.queues = {lane: queue.Queue() for lane in CFG['workers']}
        self.order = {lane: deque() for lane in CFG['workers']}
        self.hits: dict[tuple[str, str], deque] = defaultdict(deque)
        self.procs: dict[str, subprocess.Popen] = {}
        self.sessions = SessionStore(self.data / 'sessions.sqlite', AUTH['session_ttl_hours'] * 3600, AUTH['token_bytes'])
        self.accounts = Accounts(self.data / 'accounts.sqlite', ACC)
        self.mailer = Mailer(ACC['mail'], self.data / ACC['mail']['outbox_dir'])
        self._load_jobs()
        if start_workers:
            for lane, n in CFG['workers'].items():
                for _ in range(n):
                    threading.Thread(target=self._worker, args=(lane,), daemon=True).start()
            threading.Thread(target=self._retention, daemon=True).start()

    # ---- catalog ---------------------------------------------------------------------------------------------------------
    def models(self, mode: str) -> list[dict[str, Any]]:
        spec = CFG['modes'][mode]
        out = []
        for model, pace in MATRIX['models'].items():
            provider = model.split(':', 1)[0]
            if provider in spec.get('providers', []):
                out.append({'id': model, 'provider': provider, 'temperature': pace['temperature'], 'min_interval_ms': pace['min_interval_ms'],
                            'frozen': model == HC['model'], 'key_env': PROVIDERS[provider].get('api_key_env')})
        return out

    def hosted_state(self) -> dict[str, Any]:
        spec = CFG['modes']['hosted']
        keys = {p: env_value(PROVIDERS[p].get('api_key_env')) is not None for p in spec['providers']}
        budget = self._budget()
        remaining = max(0, spec['daily_pair_budget'] - budget['pairs'])
        reason = None if any(keys.values()) and remaining > 0 else ('no project key configured on this server' if not any(keys.values())
                  else "the shared budget record cannot be read, so the shared key is paused" if budget.get('unreadable') else "today's shared budget is used up")
        return {'available': reason is None, 'reason': reason, 'remaining_pairs_today': remaining, 'providers_with_key': [p for p, k in keys.items() if k]}

    def catalog(self) -> dict[str, Any]:
        hosted = self.hosted_state()
        renderings = [r['id'] for r in MATRIX['renderings']]
        modes = {}
        for name, spec in CFG['modes'].items():
            limits = {k: v for k, v in spec.items() if k.startswith(('max_', 'per_client', 'daily'))}
            modes[name] = {'label': spec['label'], 'live': spec['live'], 'limits': limits, 'models': self.models(name) if spec['live'] else [],
                           'available': hosted['available'] if name == 'hosted' else True, 'reason': hosted['reason'] if name == 'hosted' else None,
                           **({'remaining_pairs_today': hosted['remaining_pairs_today']} if name == 'hosted' else {})}
        cases = [{'id': c['case_id'], 'kind': c['kind'], 'workflow': WORKFLOW[c['fixture_id'].split('--')[0]], 'scripted_only': bool(c.get('scripted_only'))} for c in SUITE['cases']]
        return {'modes': modes, 'systems': [{'id': k, **v} for k, v in CFG['systems'].items()], 'renderings': renderings, 'default_rendering': CFG['default_rendering'],
                'cases': cases, 'agents': CFG['agents'], 'frozen': {'system': HC['defended_system']['system'], 'model': HC['model'], 'prompt_profile': HC['prompt_profile']},
                'holdouts': 'sealed; never offered or run by this service', 'access_token_required': bool(sec.get(CFG['access_token_env'])),
                'auth': {'session': 'POST /api/session (anonymous, no account)', 'retention_hours': CFG['retention_hours'], 'session_ttl_hours': AUTH['session_ttl_hours'],
                         'accounts': {'signup': 'POST /api/auth/signup', 'retention_days': ACC['account_retention_days'], 'verified_quota_multiplier': ACC['verified_quota_multiplier'],
                                      'email_delivery': self.mailer.mode, 'password_min_length': ACC['password_policy']['min_length']}}}

    # ---- validation and quotas ---------------------------------------------------------------------------------------------
    def validate(self, req: RunRequest) -> dict[str, Any]:
        if req.mode not in CFG['modes']:
            raise HTTPException(400, f"mode must be one of {', '.join(CFG['modes'])}")
        spec = CFG['modes'][req.mode]
        agent = CFG['agents'].get(req.agent)
        if not agent:
            raise HTTPException(400, f"agent must be one of {', '.join(CFG['agents'])}")
        if agent['status'] != 'available':
            raise HTTPException(400, f"agent '{req.agent}' is planned, not available yet ({agent.get('tasks')})")
        system = CFG['systems'].get(req.system)
        if not system or req.mode not in system['modes']:
            raise HTTPException(400, f"system '{req.system}' is not offered in mode {req.mode}")
        rendering = req.rendering or CFG['default_rendering']
        if rendering not in [r['id'] for r in MATRIX['renderings']]:
            raise HTTPException(400, 'unknown rendering')
        by_id = {c['case_id']: c for c in SUITE['cases']}
        cases = req.cases or [c['case_id'] for c in SUITE['cases'] if not (spec['live'] and c.get('scripted_only'))]
        unknown = [c for c in cases if c not in by_id or (spec['live'] and by_id[c].get('scripted_only'))]
        if unknown or len(set(cases)) != len(cases):
            raise HTTPException(400, f'cases not offered in this mode: {unknown[:5]}' if unknown else 'duplicate cases')
        if req.repetitions > spec['max_repetitions']:
            raise HTTPException(400, f"at most {spec['max_repetitions']} repetitions in mode {req.mode}")
        pairs = len(cases) * req.repetitions
        if pairs > spec['max_pairs_per_run']:
            raise HTTPException(400, f"{pairs} pairs requested; at most {spec['max_pairs_per_run']} per run in mode {req.mode}")
        model = None
        if spec['live']:
            models = {m['id']: m for m in self.models(req.mode)}
            if req.model not in models:
                raise HTTPException(400, f"model must be one of {', '.join(models)}")
            model = models[req.model]
            if req.mode == 'own_key':
                if not req.api_key or not re.fullmatch(spec['key_pattern'], req.api_key):
                    raise HTTPException(400, 'own_key mode needs a valid-looking provider key in api_key')
            if req.mode == 'hosted':
                state = self.hosted_state()
                if model['provider'] not in state['providers_with_key']:
                    raise HTTPException(503, 'hosted mode is not available for this provider on this server: use scripted or your own key')
                if pairs > state['remaining_pairs_today']:
                    raise HTTPException(429, f"today's shared budget has {state['remaining_pairs_today']} pairs left: use fewer cases, scripted mode or your own key")
        elif req.api_key:
            raise HTTPException(400, 'scripted mode takes no key')
        if req.mode == 'scripted' and CFG['systems'][req.system].get('frozen'):
            raise HTTPException(400, 'the frozen system uses a model-based defense and needs a live mode')
        return {'mode': req.mode, 'system': req.system, 'rendering': rendering, 'model': model, 'cases': cases, 'repetitions': req.repetitions, 'pairs': pairs, 'agent': req.agent}

    def rate_limit(self, client: str, mode: str, owner: Optional[str] = None, multiplier: int = 1):
        """Per-client limits of the mode, plus a per-session limit (TB-039), so neither a new session nor a new address
        escapes the other's quota."""
        spec = CFG['modes'][mode]
        windows = [((client, k), 3600 if k.endswith('hour') else 86400, spec[k] * multiplier, 'from one client') for k in spec if k.startswith('per_client_runs_per_')]
        if owner:
            windows.append(((owner, 'per_session_runs_per_hour'), 3600, AUTH['per_session_runs_per_hour'] * multiplier, 'from one session'))
        t = time.time()
        with self.lock:
            for key, span, limit, who in windows:
                q = self.hits[key]
                while q and q[0] < t - span:
                    q.popleft()
                if len(q) >= limit:
                    raise HTTPException(429, f'rate limit: at most {limit} runs per {"hour" if span == 3600 else "day"} {who}')
            for key, _, _, _ in windows:
                self.hits[key].append(t)

    # ---- sessions and access (TB-039) -------------------------------------------------------------------------------------
    def new_session(self, client: str) -> dict[str, Any]:
        if self.sessions.recent_for_client(client, 3600) >= AUTH['sessions_per_client_per_hour']:
            raise HTTPException(429, f"rate limit: at most {AUTH['sessions_per_client_per_hour']} new sessions per hour from one client")
        token, expires = self.sessions.create(client)
        return {'token': token, 'expires_at': datetime.fromtimestamp(expires, timezone.utc).isoformat(timespec='seconds'), 'header': f"{AUTH['session_header']}: Bearer <token>"}

    def can_read(self, job: dict[str, Any], viewer: Optional[str], share: Optional[str]) -> bool:
        if viewer == ADMIN or (viewer and secrets.compare_digest(job.get('_owner', ''), viewer)):
            return True
        return bool(share and job.get('_share') and secrets.compare_digest(job['_share'], digest(share)))

    def get_job(self, job_id: str, viewer: Optional[str], share: Optional[str] = None, owner_only: bool = False) -> dict[str, Any]:
        """The run if this viewer may see it. Missing and forbidden look the same (404), so run ids cannot be probed."""
        job = self.jobs.get(job_id)
        if not job or job.get('_deleted') or not (self.can_read(job, viewer, None if owner_only else share)):
            raise HTTPException(404, 'unknown run')
        return job

    def list_runs(self, owner: str) -> list[dict[str, Any]]:
        mine = [j for j in self.jobs.values() if not j.get('_deleted') and (owner == ADMIN or j.get('_owner') == owner)]
        return [self.public(j['id']) | ({'owner': j.get('_owner', '')[:12]} if owner == ADMIN else {}) for j in sorted(mine, key=lambda j: j['created_at'], reverse=True)]

    def share(self, job_id: str, owner: str) -> dict[str, Any]:
        job = self.get_job(job_id, owner, owner_only=True)
        token = secrets.token_urlsafe(24)
        job['_share'] = digest(token)
        self._save(job)
        return {'share_token': token, 'how': f"send it in the {AUTH['share_header']} header; the website puts it in the link's #share= fragment"}

    def unshare(self, job_id: str, owner: str):
        job = self.get_job(job_id, owner, owner_only=True)
        job.pop('_share', None)
        self._save(job)

    def delete(self, job_id: str, actor: str) -> dict[str, Any]:
        """Remove a run and every artifact linked to it: job record, report, evaluation, spans, traces and logs. A running
        run is stopped first. Returns what was removed."""
        job = self.get_job(job_id, actor, owner_only=True)
        with self.lock:
            job['_deleted'] = True
            proc = self.procs.get(job_id)
            for lane in self.order.values():
                if job_id in lane:
                    lane.remove(job_id)
        if proc:
            stop_group(proc)
        d = self._dir(job_id)
        files = sum(1 for f in d.rglob('*') if f.is_file()) if d.exists() else 0
        shutil.rmtree(d, ignore_errors=True)
        self.secrets.pop(job_id, None)
        with self.lock:
            self.jobs.pop(job_id, None)
        return {'deleted': job_id, 'files_removed': files}

    def delete_session(self, owner: str) -> dict[str, Any]:
        runs = [j['id'] for j in list(self.jobs.values()) if j.get('_owner') == owner]
        removed = sum(self.delete(r, owner)['files_removed'] for r in runs)
        self.sessions.delete(owner)
        return {'deleted_runs': len(runs), 'files_removed': removed}

    def sweep(self, now_ts: Optional[float] = None) -> dict[str, int]:
        """Retention job: runs past retention_hours, and every run of an expired session, are deleted with their artifacts;
        expired sessions are removed."""
        t = now_ts or time.time()
        guest_cutoff = t - CFG['retention_hours'] * 3600
        account_cutoff = t - ACC['account_retention_days'] * 86400
        rows = self.sessions.expired(t)
        expired_guests = {r['token_hash'] for r in rows if not r['user_id']}
        runs = 0
        for job_id, job in list(self.jobs.items()):
            finished = job['status'] not in ('queued', 'running') and job.get('finished_at') and datetime.fromisoformat(job['finished_at']).timestamp()
            cutoff = account_cutoff if str(job.get('_owner', '')).startswith('u:') else guest_cutoff
            if (finished and finished < cutoff) or job.get('_owner') in expired_guests:
                self.delete(job_id, ADMIN)
                runs += 1
        for r in rows:  # an expired account session only signs that device out; the account's runs stay until their retention
            self.sessions.delete(r['token_hash'])
        return {'runs_deleted': runs, 'sessions_deleted': len(rows)}

    # ---- accounts (TB-039) --------------------------------------------------------------------------------------------------
    def auth_attempt(self, client: str):
        t = time.time()
        with self.lock:
            q = self.hits[(client, 'auth')]
            while q and q[0] < t - 3600:
                q.popleft()
            if len(q) >= ACC['auth_attempts_per_client_per_hour']:
                raise HTTPException(429, f"rate limit: at most {ACC['auth_attempts_per_client_per_hour']} sign-in or account requests per hour from one client")
            q.append(t)

    def claim(self, guest_owner: Optional[str], account_owner: str) -> int:
        """Move a guest session's runs to the account it signs up or in to."""
        if not guest_owner or guest_owner.startswith('u:'):
            return 0
        moved = 0
        for job in list(self.jobs.values()):
            if job.get('_owner') == guest_owner and not job.get('_deleted'):
                job['_owner'] = account_owner
                self._save(job)
                moved += 1
        self.sessions.delete(guest_owner)
        return moved

    def account_session(self, user: dict, client: str) -> dict[str, Any]:
        token, expires = self.sessions.create(client, user['id'], ACC['session_ttl_days'] * 86400)
        return {'token': token, 'expires_at': datetime.fromtimestamp(expires, timezone.utc).isoformat(timespec='seconds'), 'account': self.me_for(user)}

    def me_for(self, user: Optional[dict]) -> dict[str, Any]:
        if not user:
            return {'kind': 'guest', 'retention_hours': CFG['retention_hours'], 'quota_multiplier': 1}
        return {'kind': 'account', 'email': user['email'], 'verified': bool(user['verified']), 'retention_days': ACC['account_retention_days'],
                'quota_multiplier': ACC['verified_quota_multiplier'] if user['verified'] else 1}

    def send_link(self, user: dict, purpose: str, base_url: str):
        token = self.accounts.issue(purpose, user['id'])
        link = base_url.rstrip('/') + ACC['links'][purpose].format(token=token)
        subject = {'verify': 'Verify your TrustBench account', 'reset': 'Reset your TrustBench password'}[purpose]
        body = {'verify': f'Confirm this address for your TrustBench account:\n\n{link}\n\nThe link works once and expires in {ACC["token_ttl_minutes"]["verify"] // 60} hours.',
                'reset': f'Someone asked to reset the password of the TrustBench account for this address. If it was you:\n\n{link}\n\nThe link works once and expires in {ACC["token_ttl_minutes"]["reset"]} minutes. If it was not you, ignore this email.'}[purpose]
        self.mailer.send(user['email'], subject, body)

    def delete_account(self, user_id: str) -> dict[str, Any]:
        owner = f'u:{user_id}'
        runs = [j['id'] for j in list(self.jobs.values()) if j.get('_owner') == owner]
        removed = sum(self.delete(r, owner)['files_removed'] for r in runs)
        self.sessions.delete_for_user(user_id)
        self.accounts.delete(user_id)
        return {'deleted_runs': len(runs), 'files_removed': removed, 'account_deleted': True}

    def _budget(self) -> dict[str, Any]:
        p = self.data / CFG['modes']['hosted']['budget_file']
        today = datetime.now(timezone.utc).date().isoformat()
        try:
            b = json.loads(p.read_text()) if p.exists() else {}
            if not isinstance(b, dict) or not isinstance(b.get('pairs', 0), int):
                raise ValueError
        except (OSError, ValueError):
            # TB-040: an unreadable or damaged spend record fails closed: the shared budget counts as spent for today
            # (visitors can still bring their own key or run scripted), never as unspent.
            return {'date': today, 'pairs': CFG['modes']['hosted']['daily_pair_budget'], 'unreadable': True}
        return b if b.get('date') == today else {'date': today, 'pairs': 0}

    def _spend(self, pairs: int):
        with self.lock:
            b = self._budget()
            b.pop('unreadable', None)
            b['pairs'] += pairs
            (self.data / CFG['modes']['hosted']['budget_file']).write_text(json.dumps(b))

    # ---- jobs ---------------------------------------------------------------------------------------------------------------
    def submit(self, req: RunRequest, client: str, owner: str, multiplier: int = 1) -> dict[str, Any]:
        spec = self.validate(req)
        self.rate_limit(client, req.mode, owner, multiplier)
        job_id = secrets.token_hex(12)  # hex: unguessable, and never starts with '-' (a CLI argument must not look like a flag)
        job = {'id': job_id, 'status': 'queued', 'created_at': now(), 'started_at': None, 'finished_at': None, **spec,
               'key_source': {'scripted': None, 'hosted': 'project', 'own_key': 'visitor'}[req.mode], 'progress': {'done': 0, 'total': spec['pairs']}, 'error': None,
               '_owner': owner}
        try:
            self._save(job)  # TB-040: a run that cannot be recorded is refused up front, before any budget is reserved
        except OSError:
            shutil.rmtree(self.data / 'jobs' / job_id, ignore_errors=True)
            raise HTTPException(503, 'storage_unavailable: the service cannot record runs right now; nothing was started')
        if req.mode == 'hosted':
            self._spend(spec['pairs'])  # reserved at submission so concurrent visitors cannot overspend the shared budget
        lane = 'live' if CFG['modes'][req.mode]['live'] else 'scripted'
        with self.lock:
            self.jobs[job_id] = job
            if req.api_key:
                self.secrets[job_id] = req.api_key
                sec.remember(req.api_key)  # log redaction covers it while the run exists
            self.order[lane].append(job_id)
        self._save(job)
        self.queues[lane].put(job_id)
        return self.public(job_id)

    def public(self, job_id: str) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if not job:
            raise HTTPException(404, 'unknown run')
        out = {k: v for k, v in job.items() if not k.startswith('_')}
        lane = 'live' if CFG['modes'][job['mode']]['live'] else 'scripted'
        if job['status'] == 'queued' and job_id in self.order[lane]:
            out['queue_position'] = list(self.order[lane]).index(job_id) + 1
        if job['status'] == 'running':
            log = self._dir(job_id) / 'runner.log'
            done = sum(line.startswith('done ') for line in log.read_text(errors='ignore').splitlines()) if log.exists() else 0
            out['progress'] = {'done': done, 'total': job['pairs']}
        return out

    def _dir(self, job_id: str) -> Path:
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,32}', job_id):
            raise HTTPException(404, 'unknown run')
        return self.data / 'jobs' / job_id

    def _save(self, job):
        if job.get('_deleted'):
            return
        d = self._dir(job['id'])
        d.mkdir(parents=True, exist_ok=True)
        (d / 'job.json').write_text(json.dumps(job, indent=1))

    def _load_jobs(self):
        for p in (self.data / 'jobs').glob('*/job.json'):
            job = json.loads(p.read_text())
            if job['status'] in ('queued', 'running'):
                job.update(status='failed', error='the service restarted before this run finished', finished_at=now())
                self._save(job)
            self.jobs[job['id']] = job

    def command(self, job) -> tuple[list[str], dict[str, str]]:
        d = self._dir(job['id'])
        args = [*self.runner, '--defended-system', job['system'], '--attack-rendering', job['rendering'], '--cases', ','.join(job['cases']),
                '--out-dir', str(d / 'out'), '--work-dir', str(d / 'work'), '--report-prefix', 'live']
        env = {k: v for k, v in os.environ.items() if k not in {p.get('api_key_env') for p in PROVIDERS.values() if p.get('api_key_env')}}
        if job['model']:
            m = job['model']
            args += ['--model', m['id'], '--repetitions', str(job['repetitions']), '--temperature', str(m['temperature']), '--min-interval-ms', str(m['min_interval_ms']),
                     '--prompt-profile', HC['prompt_profile']]
            if job['system'] in CFG['frozen_settings_for']:
                args += ['--reliability', HC['reliability']['override_file']]
            key_env = m['key_env']
            key = self.secrets.get(job['id']) if job['mode'] == 'own_key' else env_value(key_env)
            if key_env and key:
                env[key_env] = key
            env['TRUSTBENCH_NO_DOTENV'] = '1'  # the runner must use exactly the key given here, never fall back to .env
        return args, env

    def _worker(self, lane: str):
        while True:
            job_id = self.queues[lane].get()
            job = self.jobs.get(job_id)
            if not job or job.get('_deleted'):
                self.queues[lane].task_done()
                continue
            with self.lock:
                if job_id in self.order[lane]:
                    self.order[lane].remove(job_id)
                job.update(status='running', started_at=now())
            self._save(job)
            d = self._dir(job_id)
            try:
                args, env = self.command(job)
                with open(d / 'runner.log', 'w') as log:
                    # TB-040: its own process group, so stopping a run also stops the gateway and tool services the runner started
                    proc = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
                    self.procs[job_id] = proc
                    code = proc.wait()
                if not job.get('_deleted'):
                    self._finish(job, code)
            except Exception as error:  # never include request data or keys in the message
                job.update(status='failed', error=f'internal error: {type(error).__name__}', finished_at=now())
            finally:
                sec.forget(self.secrets.pop(job_id, None))
                self.procs.pop(job_id, None)
                shutil.rmtree(d / 'work', ignore_errors=True)
                self._save(job)
            self.queues[lane].task_done()

    def _finish(self, job, code: int):
        d = self._dir(job['id'])
        needles = [s for s in (self.secrets.get(job['id']), *(env_value(p.get('api_key_env')) for p in PROVIDERS.values())) if s and len(s) >= 8]
        for f in d.rglob('*'):
            if f.is_file() and needles and any(n in f.read_text(errors='ignore') for n in needles):
                shutil.rmtree(d / 'out', ignore_errors=True)
                (d / 'runner.log').unlink(missing_ok=True)
                job.update(status='failed', error='a provider key appeared in run output; the artifacts were deleted', finished_at=now())
                return
        report_path = d / 'out' / 'report.json'
        if not report_path.exists():
            tail = (d / 'runner.log').read_text(errors='ignore').strip().splitlines()[-1:] if (d / 'runner.log').exists() else []
            job.update(status='failed', error=f"the runner exited with code {code}" + (f": {tail[0][:300]}" if tail else ''), finished_at=now())
            return
        report = json.loads(report_path.read_text())
        su, un = _load('compute-security-utility'), _load('estimate-uncertainty')
        evaluation = {'metrics': su.evaluate_report(report), 'uncertainty': un.analyse('live', [report], 'live service run')}
        (d / 'out' / 'evaluation.json').write_text(json.dumps(evaluation, indent=1))
        s = report['summary']
        job.update(status='done' if code == 0 else 'done_with_parity_warnings', finished_at=now(), progress={'done': len(report['cases']), 'total': job['pairs']},
                   summary={'valid_pairs': s['validity']['valid_pairs'], 'invalid_pairs': s['validity']['invalid_pairs'],
                            'invalid_reasons': self._reasons(s['validity']['invalid_detail']),
                            'unsafe_committed_effect': s['unsafe_committed_effect'], 'benign_utility_pass': s['benign_utility_pass'],
                            'attacker_goal_achieved': s['attacker_goal_achieved'], 'observed_response_models': (report.get('model_revision') or {}).get('observed_response_models')})

    @staticmethod
    def _reasons(detail: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Provider failure codes behind invalid pairs, each with the plain message from configs/live-service.yaml."""
        counts: dict[str, int] = defaultdict(int)
        for d in detail:
            for side in ('baseline', 'defended'):
                if d.get(f'{side}_invalid'):
                    for code in d.get(f'{side}_failures') or ['unknown']:
                        counts[code] += 1
        messages = CFG['invalid_reason_messages']
        return [{'code': k, 'runs': n, 'message': messages.get(k, messages['default'])} for k, n in sorted(counts.items(), key=lambda kv: -kv[1])]

    def _retention(self):
        while True:
            time.sleep(AUTH['sweep_interval_s'])
            try:
                self.sweep()
            except Exception:
                pass

    def artifact(self, job_id: str, name: str, viewer: Optional[str], share: Optional[str]) -> Path:
        job = self.get_job(job_id, viewer, share)
        if job['status'] not in ('done', 'done_with_parity_warnings'):
            raise HTTPException(404, 'no results for this run (yet)')
        p = self._dir(job_id) / 'out' / name
        if not p.exists():
            raise HTTPException(404, 'not found')
        return p


def client_id(request: Request) -> str:
    if os.environ.get(CFG['trust_proxy_env']) == '1' and request.headers.get(CFG['trust_proxy_header']):
        return request.headers[CFG['trust_proxy_header']].split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


def bearer(request: Request) -> Optional[str]:
    value = request.headers.get(AUTH['session_header'], '')
    return value[7:].strip() if value.lower().startswith('bearer ') else None


def create_app(service: Optional[Service] = None) -> FastAPI:
    svc = service or Service()
    sec.install_log_redaction()

    def viewer(request: Request) -> Optional[str]:
        """The caller's identity: the operator (operator token), a session owner, or None."""
        token = bearer(request)
        admin = sec.get(AUTH['admin_token_secret'])
        if token and admin and secrets.compare_digest(token, admin):
            return ADMIN
        return svc.sessions.owner(token)

    def session_info(request: Request) -> Optional[dict]:
        return svc.sessions.info(bearer(request))

    def account_of(request: Request) -> Optional[dict]:
        i = session_info(request)
        return svc.accounts.by_id(i['user_id']) if i and i['user_id'] else None

    def multiplier(request: Request) -> int:
        user = account_of(request)
        return ACC['verified_quota_multiplier'] if user and user['verified'] else 1

    def base_url(request: Request) -> str:
        return sec.get(ACC['public_url_secret']) or str(request.base_url)

    def require_session(request: Request) -> str:
        who = viewer(request)
        if not who:
            raise HTTPException(401, 'a session is required: POST /api/session, then send Authorization: Bearer <token>')
        return who

    def share_of(request: Request) -> Optional[str]:
        return request.headers.get(AUTH['share_header'])
    api = FastAPI(title='TrustBench live-test service', docs_url='/api/docs', redoc_url=None, openapi_url='/api/openapi.json')
    api.state.service = svc

    @api.middleware('http')
    async def limit_body(request: Request, call_next):
        if int(request.headers.get('content-length') or 0) > CFG['max_request_bytes']:
            return JSONResponse(status_code=413, content={'detail': 'request too large'})
        response = await call_next(request)
        for name, value in CFG['security_headers'].items():
            if not (name == 'Content-Security-Policy' and request.url.path.startswith('/api/docs')):  # the API docs page loads its own assets
                response.headers.setdefault(name, value)
        if request.url.path.startswith('/api/'):
            response.headers.setdefault('Cache-Control', 'no-store')
        return response

    @api.get('/api/health')
    def health():
        return {'ok': True, 'jobs': len(svc.jobs)}

    @api.get('/api/catalog')
    def catalog():
        return svc.catalog()

    def demo_gate(request: Request):
        token = sec.get(CFG['access_token_env'])
        if token and not secrets.compare_digest(request.headers.get('x-trustbench-token', ''), token):
            raise HTTPException(401, 'this deployment requires an access token (X-TrustBench-Token)')

    @api.post('/api/session', status_code=201)
    def create_session(request: Request):
        demo_gate(request)
        return svc.new_session(client_id(request))

    @api.delete('/api/session')
    def delete_session(request: Request):
        """A guest: delete this session and every run it created, with all their artifacts. An account: sign this session
        out (the account's runs stay; DELETE /api/auth/account removes them)."""
        owner = require_session(request)
        if owner == ADMIN:
            raise HTTPException(400, 'the operator token is not a session')
        info = session_info(request)
        if info and info['user_id']:
            svc.sessions.delete(info['session'])
            return {'signed_out': True}
        return svc.delete_session(owner)

    # ---- accounts -------------------------------------------------------------------------------------------------------
    @api.get('/api/auth/me')
    def me(request: Request):
        require_session(request)
        return svc.me_for(account_of(request))

    @api.post('/api/auth/signup', status_code=201)
    def signup(body: Credentials, request: Request):
        demo_gate(request)
        svc.auth_attempt(client_id(request))
        email = svc.accounts.normalise(body.email)
        if not EMAIL.fullmatch(email):
            raise HTTPException(400, 'enter a valid email address')
        problem = svc.accounts.password_problem(body.password, email)
        if problem:
            raise HTTPException(400, problem)
        existing = svc.accounts.by_email(email)
        if existing:
            # Same answer as a new sign-up, so the response does not reveal which addresses have accounts; the owner of the
            # address is told by email instead.
            svc.mailer.send(email, 'TrustBench sign-up attempt', 'Someone tried to create a TrustBench account with this address, which already has one. '
                                                                'If it was you, sign in or reset your password. Otherwise ignore this email.')
            return {'message': ACC['messages']['signup']}
        user = svc.accounts.create(email, body.password)
        svc.send_link(user, 'verify', base_url(request))
        return {'message': ACC['messages']['signup']}  # identical for new and existing addresses; the account starts from the emailed link

    @api.post('/api/auth/verify')
    def verify(body: TokenOnly, request: Request):
        """Confirm the address from the emailed link; this signs the new account in (and moves this guest's runs to it)."""
        svc.auth_attempt(client_id(request))
        user_id = svc.accounts.redeem('verify', body.token)
        user = svc.accounts.by_id(user_id) if user_id else None
        if not user:
            raise HTTPException(400, 'this verification link is invalid or has expired: ask for a new one')
        svc.accounts.mark_verified(user_id)
        session = svc.account_session(svc.accounts.by_id(user_id), client_id(request))
        session['claimed_runs'] = svc.claim(svc.sessions.owner(bearer(request)), f'u:{user_id}')
        return session

    @api.post('/api/auth/verify/resend')
    def resend(body: EmailOnly, request: Request):
        svc.auth_attempt(client_id(request))
        user = svc.accounts.by_email(body.email)
        if user and not user['verified']:
            svc.send_link(user, 'verify', base_url(request))
        return {'message': 'If an unverified account uses this address, a new verification link has been sent to it.'}

    @api.post('/api/auth/login')
    def login(body: Credentials, request: Request):
        demo_gate(request)
        svc.auth_attempt(client_id(request))
        user, reason = svc.accounts.authenticate(body.email, body.password)
        if not user:
            raise HTTPException(401, reason)
        if not user['verified']:  # said only after the right password, so it reveals nothing to someone guessing addresses
            raise HTTPException(403, 'verify your email address first: use the link we sent, or ask for a new one')
        session = svc.account_session(user, client_id(request))
        session['claimed_runs'] = svc.claim(svc.sessions.owner(bearer(request)), f"u:{user['id']}")
        return session

    @api.post('/api/auth/password/forgot')
    def forgot(body: EmailOnly, request: Request):
        svc.auth_attempt(client_id(request))
        user = svc.accounts.by_email(body.email)
        if user:
            svc.send_link(user, 'reset', base_url(request))
        return {'message': ACC['messages']['forgot']}

    @api.post('/api/auth/password/reset')
    def reset(body: Reset, request: Request):
        svc.auth_attempt(client_id(request))
        user_id = svc.accounts.redeem('reset', body.token)
        user = svc.accounts.by_id(user_id) if user_id else None
        if not user:
            raise HTTPException(400, 'this reset link is invalid or has expired: ask for a new one')
        problem = svc.accounts.password_problem(body.password, user['email'])
        if problem:
            raise HTTPException(400, problem)
        svc.accounts.set_password(user['id'], body.password)
        svc.sessions.delete_for_user(user['id'])  # every signed-in device must sign in again
        svc.accounts.mark_verified(user['id'])  # the reset link proved control of the address
        return {'reset': True, 'signed_out_everywhere': True}

    @api.post('/api/auth/password/change')
    def change_password(body: PasswordChange, request: Request):
        svc.auth_attempt(client_id(request))
        user = account_of(request)
        if not user:
            raise HTTPException(401, 'sign in first')
        if not svc.accounts.check_password(body.current_password, user['password_hash']):
            raise HTTPException(401, 'the current password is wrong')
        problem = svc.accounts.password_problem(body.new_password, user['email'])
        if problem:
            raise HTTPException(400, problem)
        svc.accounts.set_password(user['id'], body.new_password)
        current = session_info(request)['session']
        for row in svc.sessions.all_rows():
            if row['user_id'] == user['id'] and row['token_hash'] != current:
                svc.sessions.delete(row['token_hash'])  # other devices are signed out; this one stays
        return {'changed': True}

    @api.delete('/api/auth/account')
    def delete_account(body: PasswordOnly, request: Request):
        user = account_of(request)
        if not user:
            raise HTTPException(401, 'sign in first')
        if not svc.accounts.check_password(body.password, user['password_hash']):
            raise HTTPException(401, 'the password is wrong')
        return svc.delete_account(user['id'])

    @api.post('/api/runs', status_code=202)
    def create_run(req: RunRequest, request: Request):
        demo_gate(request)
        owner = require_session(request)
        return svc.submit(req, client_id(request), owner, multiplier(request))

    @api.get('/api/runs')
    def my_runs(request: Request):
        return svc.list_runs(require_session(request))

    @api.get('/api/runs/{job_id}')
    def run_status(job_id: str, request: Request):
        svc.get_job(job_id, viewer(request), share_of(request))
        return svc.public(job_id)

    @api.delete('/api/runs/{job_id}')
    def delete_run(job_id: str, request: Request):
        return svc.delete(job_id, require_session(request))

    @api.post('/api/runs/{job_id}/share')
    def share_run(job_id: str, request: Request):
        return svc.share(job_id, require_session(request))

    @api.delete('/api/runs/{job_id}/share')
    def unshare_run(job_id: str, request: Request):
        svc.unshare(job_id, require_session(request))
        return {'shared': False}

    @api.get('/api/runs/{job_id}/report')
    def run_report(job_id: str, request: Request):
        return FileResponse(svc.artifact(job_id, 'report.json', viewer(request), share_of(request)), media_type='application/json', filename=f'trustbench-{job_id}-report.json')

    @api.get('/api/runs/{job_id}/evaluation')
    def run_evaluation(job_id: str, request: Request):
        return FileResponse(svc.artifact(job_id, 'evaluation.json', viewer(request), share_of(request)), media_type='application/json')

    @api.get('/api/runs/{job_id}/spans')
    def run_spans(job_id: str, request: Request):
        lines = svc.artifact(job_id, 'spans.jsonl', viewer(request), share_of(request)).read_text().splitlines()
        return [json.loads(l) for l in lines if l.strip()]

    @api.get('/api/admin/runs')
    def admin_runs(request: Request):
        if viewer(request) != ADMIN:
            raise HTTPException(404, 'not found')
        return svc.list_runs(ADMIN)

    @api.post('/api/admin/sweep')
    def admin_sweep(request: Request):
        if viewer(request) != ADMIN:
            raise HTTPException(404, 'not found')
        return svc.sweep()

    site = ROOT / CFG['static_site']
    if site.exists():
        api.mount('/assets', StaticFiles(directory=site / 'assets'), name='assets')
        if (site / 'data').exists():
            api.mount('/data', StaticFiles(directory=site / 'data'), name='data')

        @api.get('/{path:path}', include_in_schema=False)
        def spa(path: str):
            f = (site / path).resolve()
            if path and f.is_file() and site.resolve() in f.parents:
                return FileResponse(f)
            return FileResponse(site / 'index.html')
    return api


app = create_app() if os.environ.get('TRUSTBENCH_SERVICE_NO_AUTOSTART') != '1' else None
