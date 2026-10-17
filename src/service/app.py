"""TrustBench live-test service: the API behind the website's Live page and `trustbench remote`.

Three modes (configs/live-service.yaml): scripted (no model, no key), hosted (the project's free-tier key, read from the
server environment only, budget-capped) and own_key (the visitor's free-tier key, held in memory for that run, passed to
the runner in its environment, never written, logged or returned). Each job runs scripts/run-arm-smoke.mjs on the
development suite in its own directory; sealed holdouts are excluded by the runner and never offered. Before a job's
results are served, every file it produced is scanned for the keys it could have seen; a match deletes the artifacts.

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


def env_value(name: Optional[str]) -> Optional[str]:
    """A server-side secret from the process environment or the project's .env file; never returned to a client."""
    if not name:
        return None
    if os.environ.get(name):
        return os.environ[name]
    env = ROOT / '.env'
    if env.exists():
        for line in env.read_text().splitlines():
            if '=' in line and line.split('=', 1)[0].strip() == name:
                value = line.split('=', 1)[1].strip().strip('"').strip("'")
                return value or None
    return None


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
        used = self._budget()['pairs']
        remaining = max(0, spec['daily_pair_budget'] - used)
        reason = None if any(keys.values()) and remaining > 0 else ('no project key configured on this server' if not any(keys.values()) else "today's shared budget is used up")
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
                'holdouts': 'sealed; never offered or run by this service', 'access_token_required': bool(os.environ.get(CFG['access_token_env']))}

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

    def rate_limit(self, client: str, mode: str):
        spec = CFG['modes'][mode]
        windows = [(k, 3600 if k.endswith('hour') else 86400, spec[k]) for k in spec if k.startswith('per_client_runs_per_')]
        t = time.time()
        with self.lock:
            for key, span, limit in windows:
                q = self.hits[(client, key)]
                while q and q[0] < t - span:
                    q.popleft()
                if len(q) >= limit:
                    raise HTTPException(429, f'rate limit: at most {limit} {mode} runs per {key.rsplit("_", 1)[1]} from one client')
            for key, _, _ in windows:
                self.hits[(client, key)].append(t)

    def _budget(self) -> dict[str, Any]:
        p = self.data / CFG['modes']['hosted']['budget_file']
        today = datetime.now(timezone.utc).date().isoformat()
        b = json.loads(p.read_text()) if p.exists() else {}
        return b if b.get('date') == today else {'date': today, 'pairs': 0}

    def _spend(self, pairs: int):
        with self.lock:
            b = self._budget()
            b['pairs'] += pairs
            (self.data / CFG['modes']['hosted']['budget_file']).write_text(json.dumps(b))

    # ---- jobs ---------------------------------------------------------------------------------------------------------------
    def submit(self, req: RunRequest, client: str) -> dict[str, Any]:
        spec = self.validate(req)
        self.rate_limit(client, req.mode)
        if req.mode == 'hosted':
            self._spend(spec['pairs'])  # reserved at submission so concurrent visitors cannot overspend the shared budget
        job_id = secrets.token_hex(12)  # hex: unguessable, and never starts with '-' (a CLI argument must not look like a flag)
        job = {'id': job_id, 'status': 'queued', 'created_at': now(), 'started_at': None, 'finished_at': None, **spec,
               'key_source': {'scripted': None, 'hosted': 'project', 'own_key': 'visitor'}[req.mode], 'progress': {'done': 0, 'total': spec['pairs']}, 'error': None}
        lane = 'live' if CFG['modes'][req.mode]['live'] else 'scripted'
        with self.lock:
            self.jobs[job_id] = job
            if req.api_key:
                self.secrets[job_id] = req.api_key
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
            job = self.jobs[job_id]
            with self.lock:
                if job_id in self.order[lane]:
                    self.order[lane].remove(job_id)
                job.update(status='running', started_at=now())
            self._save(job)
            d = self._dir(job_id)
            try:
                args, env = self.command(job)
                with open(d / 'runner.log', 'w') as log:
                    code = subprocess.run(args, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=log).returncode
                self._finish(job, code)
            except Exception as error:  # never include request data or keys in the message
                job.update(status='failed', error=f'internal error: {type(error).__name__}', finished_at=now())
            finally:
                self.secrets.pop(job_id, None)
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
            cutoff = time.time() - CFG['retention_hours'] * 3600
            for job_id, job in list(self.jobs.items()):
                if job['status'] not in ('queued', 'running') and job.get('finished_at') and datetime.fromisoformat(job['finished_at']).timestamp() < cutoff:
                    shutil.rmtree(self._dir(job_id), ignore_errors=True)
                    self.jobs.pop(job_id, None)
            time.sleep(600)

    def artifact(self, job_id: str, name: str) -> Path:
        job = self.jobs.get(job_id)
        if not job or job['status'] not in ('done', 'done_with_parity_warnings'):
            raise HTTPException(404, 'no results for this run (yet)')
        p = self._dir(job_id) / 'out' / name
        if not p.exists():
            raise HTTPException(404, 'not found')
        return p


def client_id(request: Request) -> str:
    if os.environ.get(CFG['trust_proxy_env']) == '1' and request.headers.get(CFG['trust_proxy_header']):
        return request.headers[CFG['trust_proxy_header']].split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


def create_app(service: Optional[Service] = None) -> FastAPI:
    svc = service or Service()
    api = FastAPI(title='TrustBench live-test service', docs_url='/api/docs', redoc_url=None, openapi_url='/api/openapi.json')
    api.state.service = svc

    @api.middleware('http')
    async def limit_body(request: Request, call_next):
        if int(request.headers.get('content-length') or 0) > CFG['max_request_bytes']:
            return JSONResponse(status_code=413, content={'detail': 'request too large'})
        return await call_next(request)

    @api.get('/api/health')
    def health():
        return {'ok': True, 'jobs': len(svc.jobs)}

    @api.get('/api/catalog')
    def catalog():
        return svc.catalog()

    @api.post('/api/runs', status_code=202)
    def create_run(req: RunRequest, request: Request):
        token = os.environ.get(CFG['access_token_env'])
        if token and not secrets.compare_digest(request.headers.get('x-trustbench-token', ''), token):
            raise HTTPException(401, 'this deployment requires an access token (X-TrustBench-Token)')
        return svc.submit(req, client_id(request))

    @api.get('/api/runs/{job_id}')
    def run_status(job_id: str):
        return svc.public(job_id)

    @api.get('/api/runs/{job_id}/report')
    def run_report(job_id: str):
        return FileResponse(svc.artifact(job_id, 'report.json'), media_type='application/json', filename=f'trustbench-{job_id}-report.json')

    @api.get('/api/runs/{job_id}/evaluation')
    def run_evaluation(job_id: str):
        return FileResponse(svc.artifact(job_id, 'evaluation.json'), media_type='application/json')

    @api.get('/api/runs/{job_id}/spans')
    def run_spans(job_id: str):
        lines = svc.artifact(job_id, 'spans.jsonl').read_text().splitlines()
        return [json.loads(l) for l in lines if l.strip()]

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
