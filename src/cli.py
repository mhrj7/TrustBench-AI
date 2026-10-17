"""TrustBench benchmark CLI (TB-037).

  trustbench validate            fixture, split, protocol and frozen-configuration checks
  trustbench fetch-data          clone the pinned AgentDojo checkout recorded in data/manifest.json
  trustbench smoke [--check]     credential-free smoke runs; --check compares them with the committed results and the schema
  trustbench benchmark PROFILE   a live paired run from configs/cli/benchmark-<PROFILE>.yaml (provider key and budget needed)
  trustbench evaluate REPORT...  security, utility and uncertainty for arm-comparison reports
  trustbench report [--check]    regenerate the published reports; --check runs their reproduction tests
  trustbench manifest [--write]  check (or write) the pinned data, lock and protocol hashes
  trustbench remote ...          the same runs on a live-test service (the website's API): catalog, run, status, report

Every step is named in configs/cli/trustbench.yaml and delegates to the project's own scripts."""
import hashlib, importlib.util, json, os, subprocess, sys, time
from pathlib import Path
from typing import Annotated, Optional

import typer

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'configs/cli/trustbench.yaml').read_text())
PY = sys.executable
app = typer.Typer(help=__doc__.split('\n\n')[0], no_args_is_help=True, add_completion=False)


def npm(script: str, quiet: bool = False) -> int:
    return subprocess.run(['npm', 'run', '-s', script], cwd=ROOT, stdout=subprocess.DEVNULL if quiet else None).returncode


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalise(value, volatile: set[str]):
    if isinstance(value, dict):
        return {k: normalise(v, volatile) for k, v in sorted(value.items()) if k not in volatile}
    if isinstance(value, list):
        return [normalise(v, volatile) for v in value]
    return value


def committed(path: str):
    out = subprocess.run(['git', 'show', f'HEAD:{path}'], cwd=ROOT, capture_output=True, text=True)
    return json.loads(out.stdout) if out.returncode == 0 else None


def schema_errors(report: dict, schema_path: str) -> list[str]:
    from jsonschema import Draft202012Validator
    v = Draft202012Validator(json.loads((ROOT / schema_path).read_text()))
    return [f'{e.json_path}: {e.message[:160]}' for e in v.iter_errors(report)]


def done(results: list[dict]):
    ok = all(r['ok'] for r in results)
    typer.echo(json.dumps({'ok': ok, 'steps': results}, indent=1))
    raise typer.Exit(0 if ok else 1)


@app.command()
def validate():
    """Validate fixtures, splits, the sealed manifests, the protocol and the frozen configuration."""
    results = [{'step': s, 'ok': npm(s, quiet=True) == 0} for s in CFG['validate']['steps']]
    vendor = ROOT / json.loads((ROOT / 'data/manifest.json').read_text())['source']['relative_path']
    if vendor.exists():
        results.append({'step': CFG['validate']['vendor_step'], 'ok': npm(CFG['validate']['vendor_step'], quiet=True) == 0})
    else:
        results.append({'step': CFG['validate']['vendor_step'], 'ok': True, 'skipped': CFG['validate']['vendor_note']})
    done(results)


@app.command('fetch-data')
def fetch_data():
    """Clone the pinned AgentDojo checkout (data/manifest.json download_steps_portable) and verify it."""
    m = json.loads((ROOT / 'data/manifest.json').read_text())
    if (ROOT / m['source']['relative_path'] / '.git').exists():
        typer.echo(f"{m['source']['relative_path']} exists")
    else:
        for step in m['download_steps_portable']:
            if subprocess.run(step.split(), cwd=ROOT).returncode != 0:
                raise typer.Exit(1)
    raise typer.Exit(npm('verify:data'))


@app.command()
def smoke(check: Annotated[bool, typer.Option(help='compare each output with the committed result and validate it against its schema')] = False):
    """Credential-free smoke runs: environment fixture, scripted smoke suite and scripted arm comparison."""
    results = []
    for step in CFG['smoke']['steps']:
        r = {'step': step['name'], 'ok': npm(step['npm'], quiet=True) == 0}
        if check and r['ok'] and step.get('output'):
            fresh = json.loads((ROOT / step['output']).read_text())
            base = committed(step['output'])
            volatile = set(step.get('volatile_keys', []))
            r['matches_committed'] = base is not None and normalise(fresh, volatile) == normalise(base, volatile)
            r['ignored_volatile_keys'] = sorted(volatile)
            if step.get('schema'):
                errors = schema_errors(fresh, step['schema'])
                r['schema'] = step['schema']
                r['schema_errors'] = errors[:5]
                r['ok'] &= not errors
            r['ok'] &= r['matches_committed']
        results.append(r)
    done(results)


def key_available(key: Optional[str]) -> bool:
    """True when the provider needs no key, or the key is set in the environment or in .env (the value is never read out)."""
    if not key or os.environ.get(key):
        return True
    env = ROOT / '.env'
    return env.exists() and any(line.split('=', 1)[0].strip() == key and line.split('=', 1)[1].strip() for line in env.read_text().splitlines() if '=' in line)


@app.command()
def benchmark(profile: Annotated[str, typer.Argument(help='configs/cli/benchmark-<profile>.yaml')],
              dry_run: Annotated[bool, typer.Option(help='print the run command and stop')] = False):
    """A live paired benchmark run on development data from a profile file."""
    b = CFG['benchmark']
    p = json.loads((ROOT / b['profiles_dir'] / f"{b['profile_prefix']}{profile}.yaml").read_text())
    if p['from_frozen']:
        hc = json.loads((ROOT / 'configs/frozen/holdout-config.json').read_text())
        sel = json.loads((ROOT / 'configs/frozen/selection.json').read_text())
        pace = json.loads((ROOT / 'configs/frozen/live-matrix.yaml').read_text())['models'][hc['model']]
        run = {'model': hc['model'], 'defended_system': hc['defended_system']['system'], 'prompt_profile': hc['prompt_profile'],
               'attack_rendering': sel['data']['selection_condition']['attack_rendering'], 'temperature': pace['temperature'], 'min_interval_ms': pace['min_interval_ms'],
               'reliability': hc['reliability']['override_file']}
    else:
        run = {k: p[k] for k in ('model', 'defended_system', 'prompt_profile', 'attack_rendering', 'temperature', 'min_interval_ms')}
    args = ['node', '--experimental-strip-types', '--no-warnings', b['runner'], '--model', run['model'], '--defended-system', run['defended_system'],
            '--prompt-profile', run['prompt_profile'], '--attack-rendering', run['attack_rendering'], '--repetitions', str(p['repetitions']),
            '--temperature', str(run['temperature']), '--min-interval-ms', str(run['min_interval_ms']), '--suite', p['suite'],
            '--report-prefix', p['report_prefix'], '--work-dir', f".tool-state/cli-{p['name']}", *(['--reliability', run['reliability']] if run.get('reliability') else [])]
    provider = json.loads((ROOT / 'configs/providers.yaml').read_text())['providers'][run['model'].split(':', 1)[0]]
    key = provider.get('api_key_env')
    if dry_run:
        typer.echo(json.dumps({'profile': p['name'], 'command': args, 'credential_env': key}, indent=1))
        raise typer.Exit(0)
    if not key_available(key):
        typer.echo(f'{key} is not set in the environment or .env; a live run needs your own provider key and budget', err=True)
        raise typer.Exit(2)
    raise typer.Exit(subprocess.run(args, cwd=ROOT).returncode)


@app.command()
def evaluate(reports: Annotated[list[Path], typer.Argument(help='arm-comparison report JSON files')],
             out: Annotated[Optional[Path], typer.Option(help='write the result here instead of stdout')] = None):
    """Security and utility rates (TB-033) and paired cluster-bootstrap intervals (TB-034) for the given reports."""
    su, un = load_script('compute-security-utility'), load_script('estimate-uncertainty')
    loaded = [json.loads(p.read_text()) for p in reports]
    for p, r in zip(reports, loaded):
        errors = schema_errors(r, CFG['report_schema'])
        if errors:
            typer.echo(f'{p}: not a valid arm report: {errors[0]}', err=True)
            raise typer.Exit(1)
    result = {'reports': [str(p) for p in reports],
              'metrics': su.evaluate_cases([c for r in loaded for c in r['cases']], [r['summary'] for r in loaded]),
              'uncertainty': un.analyse('cli', loaded, 'cli')}
    text = json.dumps(result, indent=1)
    (out.write_text(text + '\n') if out else typer.echo(text))


@app.command()
def report(check: Annotated[bool, typer.Option(help='run the reproduction tests of the published reports instead of regenerating them')] = False):
    """Regenerate the published TB-033..TB-036 reports from their raw records, or check that they reproduce."""
    if check:
        raise typer.Exit(subprocess.run([PY, '-m', 'pytest', '-q', *CFG['report']['check_tests']], cwd=ROOT).returncode)
    done([{'step': s, 'ok': npm(s, quiet=True) == 0} for s in CFG['report']['steps']])


def digests() -> dict[str, str]:
    return {f: hashlib.sha256((ROOT / f).read_bytes()).hexdigest() for f in CFG['manifest']['include']}


@app.command()
def manifest(write: Annotated[bool, typer.Option(help='rewrite the pinned manifest from the current files')] = False):
    """Check the pinned content hashes of the data, locks, frozen-configuration manifest, schema and protocol."""
    path = ROOT / CFG['manifest']['file']
    current = digests()
    if write:
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({'schema_version': '1.0.0', 'note': CFG['manifest']['note'], 'files': current}, indent=1) + '\n')
        typer.echo(f'wrote {path.relative_to(ROOT)} ({len(current)} files)')
        raise typer.Exit(0)
    pinned = json.loads(path.read_text())['files']
    changed = sorted(f for f in set(pinned) | set(current) if pinned.get(f) != current.get(f))
    typer.echo(json.dumps({'ok': not changed, 'files': len(current), 'changed': changed}, indent=1))
    raise typer.Exit(0 if not changed else 1)


# ---- remote: the live-test service (src/service/app.py), the same API the website's Live page uses -------------------------
remote = typer.Typer(help='Run benchmarks on a TrustBench live-test service (the website\'s API).', no_args_is_help=True)
app.add_typer(remote, name='remote')


def http(method: str, url: str, body: Optional[dict] = None, token: Optional[str] = None):
    import urllib.error, urllib.request
    headers = {'content-type': 'application/json', **({'x-trustbench-token': token} if token else {})}
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read() or b'{}').get('detail', e.reason)
        typer.echo(f'{e.code}: {detail}', err=True)
        raise typer.Exit(1)


@remote.command('catalog')
def remote_catalog(url: Annotated[str, typer.Option(help='service origin, e.g. https://trustbench.example')]):
    """Modes, models, defenses, renderings and cases this service offers, and whether the project key is available."""
    typer.echo(json.dumps(http('GET', f'{url.rstrip("/")}/api/catalog'), indent=1))


@remote.command('run')
def remote_run(url: Annotated[str, typer.Option(help='service origin')],
               mode: Annotated[str, typer.Option(help='scripted, hosted (project key) or own_key (your key)')] = 'scripted',
               system: Annotated[str, typer.Option(help='defense system id (see catalog)')] = 'gateway_capability',
               model: Annotated[Optional[str], typer.Option(help='provider:model for live modes')] = None,
               rendering: Annotated[Optional[str], typer.Option(help='attack rendering')] = None,
               cases: Annotated[Optional[str], typer.Option(help='comma-separated case ids (default: every case the mode allows)')] = None,
               repetitions: Annotated[int, typer.Option(min=1)] = 1,
               key_env: Annotated[Optional[str], typer.Option(help='own_key mode: name of the environment variable holding your key')] = None,
               token_env: Annotated[Optional[str], typer.Option(help='environment variable holding the deployment access token, if it needs one')] = None,
               wait: Annotated[bool, typer.Option(help='wait for the run and print its summary')] = False):
    """Start a paired run. Keys are read from an environment variable, never from the command line."""
    body = {'mode': mode, 'system': system, 'repetitions': repetitions, **({'model': model} if model else {}), **({'rendering': rendering} if rendering else {}),
            **({'cases': cases.split(',')} if cases else {})}
    if mode == 'own_key':
        if not key_env or not os.environ.get(key_env):
            typer.echo('own_key mode: set --key-env to the name of an environment variable that holds your key', err=True)
            raise typer.Exit(2)
        body['api_key'] = os.environ[key_env]
    base = url.rstrip('/')
    job = http('POST', f'{base}/api/runs', body, os.environ.get(token_env) if token_env else None)
    typer.echo(json.dumps({'id': job['id'], 'status': job['status'], 'pairs': job['pairs'], 'link': f"{base}/live?run={job['id']}"}, indent=1))
    while wait and job['status'] in ('queued', 'running'):
        time.sleep(3)
        job = http('GET', f"{base}/api/runs/{job['id']}")
    if wait:
        typer.echo(json.dumps({k: job.get(k) for k in ('id', 'status', 'error', 'summary')}, indent=1))
        raise typer.Exit(0 if job['status'] in ('done', 'done_with_parity_warnings') else 1)


@remote.command('status')
def remote_status(run_id: str, url: Annotated[str, typer.Option(help='service origin')]):
    """Status and summary of a run."""
    typer.echo(json.dumps(http('GET', f'{url.rstrip("/")}/api/runs/{run_id}'), indent=1))


@remote.command('report')
def remote_report(run_id: str, url: Annotated[str, typer.Option(help='service origin')],
                  out: Annotated[Optional[Path], typer.Option(help='write the report here')] = None,
                  evaluation: Annotated[bool, typer.Option(help='fetch the metrics and intervals instead of the raw report')] = False):
    """The run's arm-comparison report (schema-checked) or its evaluation."""
    data = http('GET', f'{url.rstrip("/")}/api/runs/{run_id}/{"evaluation" if evaluation else "report"}')
    if not evaluation:
        errors = schema_errors(data, CFG['report_schema'])
        if errors:
            typer.echo(f'report does not match {CFG["report_schema"]}: {errors[0]}', err=True)
            raise typer.Exit(1)
    text = json.dumps(data, indent=1)
    (out.write_text(text + '\n') if out else typer.echo(text))


if __name__ == '__main__':
    app()
