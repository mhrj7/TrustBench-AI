#!/usr/bin/env python3
"""TB-050: a fresh user can follow README.md without hidden local files.

  check-readme.py            static checks: every path, npm script, trustbench command and flag the README names exists;
                             every key variable is in .env.example; the limit table and model ids match the configs
  check-readme.py --fresh [--ref REF]
                             follow the README in a clean container as a non-root user: clone the repository from GitHub,
                             check out REF (default: HEAD, which must be pushed), run the "Install" block and the "Check the
                             install" block exactly as written, and compare each command's output with the README's
                             "Expected output" table; also the no-key path of a live benchmark. Writes evidence/tb050-readme-check.json."""
import json, re, shlex, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = (ROOT / 'README.md').read_text()
OUT = ROOT / 'evidence/tb050-readme-check.json'
REPO = 'https://github.com/mhrj7/TrustBench-AI.git'


def tracked() -> set[str]:
    return set(subprocess.run(['git', 'ls-files'], cwd=ROOT, capture_output=True, text=True).stdout.split())


def section(title: str) -> str:
    m = re.search(rf'^## {re.escape(title)}\n(.*?)(?=^## |\Z)', README, re.S | re.M)
    if not m:
        sys.exit(f'README has no section "{title}"')
    return m.group(1)


def blocks(text: str) -> list[str]:
    return re.findall(r'```bash\n(.*?)```', text, re.S)


def static() -> list[str]:
    problems, files = [], tracked()
    for target in re.findall(r'\]\(([^)#\s]+)\)', README) + re.findall(r'`((?:[\w.-]+/)+[\w.-]+\.[a-z]{2,5})`', README):
        if not target.startswith(('http', 'mailto')) and target not in files and not (ROOT / target).is_dir():
            problems.append(f'path not in the repository: {target}')
    scripts = json.loads((ROOT / 'package.json').read_text())['scripts']
    for name in set(re.findall(r'npm run ([\w:-]+)', README)):
        if name not in scripts:
            problems.append(f'npm script does not exist: {name}')
    commands = set()
    for line in re.findall(r'sh bin/trustbench [^`\n|]+', README):
        words = shlex.split(re.sub(r'<[^>]*>', 'X', line))[2:]
        sub = [w for w in words[:2] if not w.startswith('-') and w != 'X']
        if sub and sub[0] == 'remote' and len(sub) == 1:
            continue
        sub = sub[:2] if sub and sub[0] == 'remote' else sub[:1]
        commands.add((tuple(sub), tuple(w.split('=')[0] for w in words if w.startswith('--'))))
    helps = {}
    for sub, flags in sorted(commands):
        if sub not in helps:
            p = subprocess.run(['sh', 'bin/trustbench', *sub, '--help'], cwd=ROOT, capture_output=True, text=True)
            helps[sub] = (p.returncode, re.sub(r'\x1b\[[0-9;]*m', '', p.stdout))
        code, text = helps[sub]
        if code != 0:
            problems.append(f'trustbench command does not exist: {" ".join(sub)}')
        for f in flags:
            if f not in text:
                problems.append(f'trustbench {" ".join(sub)} has no option {f}')
    env_example = (ROOT / '.env.example').read_text()
    for var in set(re.findall(r'\b([A-Z][A-Z0-9_]*_API_KEY)\b', README)):
        if f'{var}=' not in env_example:
            problems.append(f'{var} is not in .env.example')
    ls = json.loads((ROOT / 'configs/live-service.yaml').read_text())['modes']
    pd = json.loads((ROOT / 'configs/deploy/public-demo.json').read_text())['modes']
    limit = lambda mode, key: min(v for v in (ls[mode].get(key), pd.get(mode, {}).get(key)) if v is not None)
    rows = {r[0].strip(): r for r in (line.split('|')[1:-1] for line in section('Try it live (nothing to install)').splitlines() if line.startswith('| '))}
    expect = {'Instant, no model': [f"{limit('scripted', 'max_pairs_per_run')} paired runs"],
              'Live, our key': [f"{limit('hosted', 'max_pairs_per_run')} paired runs", f"{limit('hosted', 'per_client_runs_per_day')} runs a day per visitor"],
              'Live, your key': [f"{limit('own_key', 'max_pairs_per_run')} paired runs"]}
    for mode, needles in expect.items():
        for n in needles:
            if mode not in rows or n not in rows[mode][-1]:
                problems.append(f'live-site limit for "{mode}" does not match the configs: expected "{n}"')
    matrix = (ROOT / 'configs/live-matrix.yaml').read_text()  # the live service's model list (configs/live-service.yaml models_from)
    for model in set(re.findall(r'`((?:nvidia|gemini):[\w./-]+)`', README)) | set(re.findall(r'--model ((?:nvidia|gemini):[\w./-]+)', README)):
        if f'"{model}"' not in matrix:
            problems.append(f'model not offered in configs/live-matrix.yaml: {model}')
    for path in re.findall(r'(/(?:Volumes|Users)/[\w./-]+)', README):
        problems.append(f'machine-specific absolute path in the README: {path}') if 'Volumes/MHRJ/.cache/npm' not in path else None
    return problems


def expected_rows() -> list[tuple[str, list[str]]]:
    rows = []
    for line in section('Check the install (no key, no model, no network)').splitlines():
        cells = [c.strip() for c in line.split('|')[1:-1]]
        if len(cells) == 2 and cells[0].startswith('`sh bin/trustbench'):
            rows.append((cells[0].strip('`'), re.findall(r'`([^`]+)`', cells[1])))
    return rows


DOCKERFILE = """FROM ghcr.io/astral-sh/uv:0.11.28@sha256:0f36cb9361a3346885ca3677e3767016687b5a170c1a6b88465ec14aefec90aa AS uv
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb
# The README's requirements, installed the way a user would: git, Node.js 26.5.0 with npm 12.0.0, uv 0.11.28.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
RUN npm install -g npm@12.0.0
USER node
WORKDIR /home/node/fresh
ENV UV_CACHE_DIR=/home/node/fresh/.cache/uv UV_PYTHON_INSTALL_DIR=/home/node/fresh/.cache/python
"""


def fresh(ref: str):
    sha = subprocess.run(['git', 'rev-parse', ref], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    remote = subprocess.run(['git', 'ls-remote', REPO], capture_output=True, text=True).stdout
    if sha not in remote and subprocess.run(['git', 'branch', '-r', '--contains', sha], cwd=ROOT, capture_output=True, text=True).stdout.strip() == '':
        sys.exit(f'{sha[:7]} is not on GitHub: push it first (the check clones like a new user)')
    install = blocks(section('Install'))[0].strip().splitlines()
    assert install[0].startswith('git clone') and install[1].startswith('cd '), 'Install must start with git clone and cd'
    install.insert(2, f'git checkout -q {sha}  # the harness pins the commit under test')
    checks = blocks(section('Check the install (no key, no model, no network)'))[0].strip().splitlines()
    nokey = ['sh bin/trustbench benchmark dev-frozen --dry-run', 'sh bin/trustbench benchmark dev-frozen']
    script = ['set -u', *install, 'echo "@@INSTALL_DONE $?"']
    for c in checks + nokey:
        script += [f'echo "@@BEGIN {c}"', f'{c} > /tmp/out 2>&1; code=$?; cat /tmp/out', f'echo "@@END $code"']
    with tempfile.TemporaryDirectory(dir=ROOT.parent, prefix='.tb050-') as tmp:
        (Path(tmp) / 'Dockerfile').write_text(DOCKERFILE)
        tag = f'trustbench-readme:{sha[:7]}'
        subprocess.run(['docker', 'build', '-q', '-t', tag, tmp], check=True, capture_output=True)
        started = datetime.now(timezone.utc).isoformat(timespec='seconds')
        p = subprocess.run(['docker', 'run', '--rm', tag, 'bash', '-c', '\n'.join(script)], capture_output=True, text=True, timeout=5400)
    log = p.stdout + p.stderr
    install_ok = '@@INSTALL_DONE 0' in log
    results = []
    for c in checks + nokey:
        m = re.search(rf'@@BEGIN {re.escape(c)}\n(.*?)@@END (\d+)', log, re.S)
        out, code = (m.group(1), int(m.group(2))) if m else ('', None)
        results.append({'command': c, 'exit_code': code, 'output_tail': out.strip().splitlines()[-6:]})
    expected = dict(expected_rows())
    problems = [] if install_ok else ['the Install block failed']
    for r in results:
        c = r['command']
        if c in expected:
            m = re.search(rf'@@BEGIN {re.escape(c)}\n(.*?)@@END', log, re.S)
            out = m.group(1) if m else ''
            r['expected'] = expected[c]
            r['expected_found'] = {e: e in out for e in expected[c] if e not in ('passed', 'failed')}
            if c.endswith('report --check'):
                r['expected_found'] = {'passed': bool(re.search(r'\d+ passed', out)), 'no failed': 'failed' not in out}
            if r['exit_code'] != 0 or not all(r['expected_found'].values()):
                problems.append(f'{c}: exit {r["exit_code"]}, expected {r["expected_found"]}')
    dry, live = results[-2], results[-1]
    if dry['exit_code'] != 0 or not any('NVIDIA_API_KEY' in l for l in dry['output_tail']):
        problems.append('benchmark --dry-run did not name the key variable')
    if live['exit_code'] == 0 or not any('NVIDIA_API_KEY is not set' in l for l in live['output_tail']):
        problems.append('a live benchmark without a key did not stop with the documented message')
    out = {'task_id': 'TB-050', 'commit': sha, 'started_at': started, 'environment': 'node:26.5.0-bookworm-slim (Debian 12), non-root user "node", '
           'fresh clone from GitHub, only the README requirements installed (git, Node.js 26.5.0, npm 12.0.0, uv 0.11.28)',
           'install_block': install, 'install_ok': install_ok, 'checks': results, 'problems': problems, 'ok': not problems,
           'log_tail': log.strip().splitlines()[-40:] if problems else []}
    OUT.write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps({'ok': out['ok'], 'install_ok': install_ok, 'problems': problems}, indent=1))
    sys.exit(0 if out['ok'] else 1)


def main():
    if '--fresh' in sys.argv:
        ref = sys.argv[sys.argv.index('--ref') + 1] if '--ref' in sys.argv else 'HEAD'
        fresh(ref)
        return
    problems = static()
    print(json.dumps({'ok': not problems, 'problems': problems}, indent=1))
    sys.exit(0 if not problems else 1)


if __name__ == '__main__':
    main()
