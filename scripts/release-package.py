#!/usr/bin/env python3
"""TB-053: the versioned release package.

  release-package.py build --tag vX.Y.Z      assets from the tagged commit only: the source archive (committed files), the
                                              technical report, the claim register, the reproduction manifest, the license
                                              and third-party notices, the release-check record, and SHA256SUMS
  release-package.py publish --tag vX.Y.Z    create the GitHub release with those assets and a quickstart in its notes
  release-package.py verify --tag vX.Y.Z     download every asset from its public link, check it against SHA256SUMS,
                                              scan the package for keys, secrets and excluded files, and run the quickstart
                                              from the downloaded source archive in a clean container; writes
                                              evidence/tb053-release.json
  release-package.py quickstart --source FILE  the quickstart alone, from a local archive under the project (a dry run)"""
import hashlib, io, json, re, subprocess, sys, tarfile, tempfile, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPRO = json.loads((ROOT / 'configs/repro.yaml').read_text())
OUT = ROOT / 'evidence/tb053-release.json'
DIST = ROOT / '.tool-state/release-package'
FILES = {'report.md': 'research/report.md', 'claims.md': 'research/claims.md', 'reproduction-manifest.json': 'repro/manifest.json',
         'LICENSE': 'LICENSE', 'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md', 'release-checks.json': 'release/checks.json'}
now = lambda: datetime.now(timezone.utc).isoformat(timespec='seconds')


def git(*a, binary=False):
    return subprocess.run(['git', *a], cwd=ROOT, capture_output=True, check=True, **({} if binary else {'text': True})).stdout


def version(tag: str) -> str:
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        sys.exit('tag must look like v1.0.0')
    return tag[1:]


def asset_names(tag):
    v = version(tag)
    return {f'trustbench-{v}-source.tar.gz': None, **{f'trustbench-{v}-{k}': src for k, src in FILES.items()}}


def build(tag):
    v = version(tag)
    out = DIST / tag
    out.mkdir(parents=True, exist_ok=True)
    sha = git('rev-list', '-n', '1', tag).strip()
    (out / f'trustbench-{v}-source.tar.gz').write_bytes(git('archive', '--format=tar.gz', f'--prefix=TrustBench-AI-{v}/', tag, binary=True))
    for name, src in asset_names(tag).items():
        if src == 'release/checks.json':  # written after the candidate commit (TB-051): it must name the tagged commit
            rec = json.loads((ROOT / src).read_text())
            if rec.get('candidate') != sha or rec.get('decision', {}).get('outcome') != 'RELEASE':
                sys.exit(f'release/checks.json is not a RELEASE decision for {sha[:12]}')
            (out / name).write_bytes((ROOT / src).read_bytes())
        elif src:
            (out / name).write_bytes(git('show', f'{tag}:{src}', binary=True))
    sums = ''.join(f'{hashlib.sha256((out / n).read_bytes()).hexdigest()}  {n}\n' for n in sorted(asset_names(tag)))
    (out / 'SHA256SUMS').write_text(sums)
    print(json.dumps({'tag': tag, 'commit': sha[:12], 'assets': sorted([*asset_names(tag), 'SHA256SUMS'])}, indent=1))


def quickstart_commands(v: str, source: str) -> list[str]:
    fetch = f'curl -fsSL {source} | tar -xz' if source.startswith('http') else f'tar -xzf {source}'
    return [fetch, f'cd TrustBench-AI-{v}',
            'export TRUSTBENCH_STORAGE_ROOT="$(dirname "$PWD")" npm_config_cache="$(dirname "$PWD")/.cache/npm"',
            'cp .env.example .env', 'npm ci', 'npm run setup',
            'sh bin/trustbench validate', 'sh bin/trustbench smoke --check', 'sh bin/trustbench manifest', 'sh bin/trustbench report --check']


def notes(tag):
    v = version(tag)
    rec = json.loads((ROOT / 'release/checks.json').read_text())
    url = f'https://github.com/mhrj7/TrustBench-AI/releases/download/{tag}/trustbench-{v}-source.tar.gz'
    cmds = '\n'.join(quickstart_commands(v, url))
    return f"""TrustBench {v}: a paired benchmark of tool-call enforcement against indirect prompt injection, with its evaluation, technical report and reproduction package. MIT licensed.

**Release checks:** {rec['decision']['outcome']} for this commit (`{rec['candidate'][:12]}`). Ten required checks are in `trustbench-{v}-release-checks.json`, including the Tier 2 live gate, a fresh-clone verify, the offline reproduction and the public site from outside. This is not a full replication: the sealed holdouts are not rerun.

**Assets:**
- the source archive (committed files only; no keys, no AgentDojo checkout);
- the technical report and the claim register;
- the reproduction manifest;
- the license and third-party notices;
- the release-check record;
- `SHA256SUMS`.

**Quickstart** (needs git, Node.js 26.5.0 with npm 12.0.0, and uv; no key, model or network after installing):

```bash
{cmds}
```

Each check exits 0. Live runs need a free-tier key (README, "API keys"). Or try it with nothing installed: https://trustbench.taila273c6.ts.net/live
"""


def publish(tag):
    out = DIST / tag
    files = [str(out / n) for n in sorted([*asset_names(tag), 'SHA256SUMS'])]
    with tempfile.NamedTemporaryFile('w', suffix='.md', delete=False) as f:
        f.write(notes(tag))
    p = subprocess.run(['gh', 'release', 'create', tag, '--verify-tag', '--title', f'TrustBench {version(tag)}', '--notes-file', f.name, *files], cwd=ROOT, capture_output=True, text=True)
    print(p.stdout.strip() or p.stderr.strip())
    sys.exit(p.returncode)


def scan(data: dict[str, bytes]) -> list[str]:
    secret = [re.compile(p.encode()) for p in REPRO['secret_patterns']]
    personal = [re.compile(p.encode()) for p in REPRO['personal_patterns']]
    allow = set(REPRO['secret_allowlist'])
    problems = []
    for name, blob in data.items():
        rel = name.split('/', 1)[1] if '/' in name else name
        if any(rel == x['path'] or rel.startswith(x['path'].rstrip('/') + '/') for x in REPRO['exclusions']):
            problems.append(f'excluded path in the package: {name}')
        if rel in allow or rel.endswith(('package-lock.json', '.xlsx', '.jpg', '.png', '.webm', '.sqlite', '.pdf')):
            continue
        for rx in secret + personal:
            if rx.search(blob):
                problems.append(f'{rx.pattern.decode()!r} in {name}')
    return problems


def run_quickstart(v: str, source: str, mount: Path | None) -> dict:
    image = 'trustbench-readme:quickstart'
    dockerfile = (ROOT / 'scripts/check-readme.py').read_text().split('DOCKERFILE = """', 1)[1].split('"""', 1)[0]
    with tempfile.TemporaryDirectory(dir=ROOT.parent, prefix='.tb053-') as tmp:
        (Path(tmp) / 'Dockerfile').write_text(dockerfile)
        subprocess.run(['docker', 'build', '-q', '-t', image, tmp], check=True, capture_output=True)
    cmds = quickstart_commands(v, source if source.startswith('http') else '/src/' + Path(source).name)
    script = ['set -u']
    for i, c in enumerate(cmds):  # numbered markers: a command's own text may expand inside an echo
        script += [f'echo "@@BEGIN {i}"', f'{c} > /tmp/out 2>&1; code=$?; tail -3 /tmp/out', f'echo "@@END $code"']
        if c.startswith(('curl', 'tar', 'cd ', 'export')):
            script[-2] = f'{c}; code=$?; true'
    args = ['docker', 'run', '--rm'] + (['-v', f'{mount}:/src:ro'] if mount else []) + [image, 'bash', '-c', '\n'.join(script)]
    p = subprocess.run(args, capture_output=True, text=True, timeout=5400)
    log = p.stdout + p.stderr
    steps = []
    for i, c in enumerate(cmds):
        m = re.search(rf'@@BEGIN {i}\n(.*?)@@END (\d+)', log, re.S)
        steps.append({'command': c.replace(source, '<source archive>'), 'exit_code': int(m.group(2)) if m else None, 'tail': (m.group(1).strip().splitlines()[-2:] if m else [])})
    return {'environment': 'node:26.5.0-bookworm-slim (Debian 12), non-root, only git, Node.js 26.5.0, npm 12.0.0 and uv 0.11.28 installed',
            'source': 'the downloaded release archive' if source.startswith('http') else 'a local archive', 'steps': steps,
            'ok': all(s['exit_code'] == 0 for s in steps)}


def verify(tag):
    v = version(tag)
    rel = json.loads(subprocess.run(['gh', 'release', 'view', tag, '--json', 'url,assets,tagName,isDraft'], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
    data = {}
    for a in rel['assets']:
        with urllib.request.urlopen(a['url'], timeout=120) as r:
            data[a['name']] = r.read()
    sums = dict(reversed(l.split('  ', 1)) for l in data['SHA256SUMS'].decode().splitlines())
    checksum = {n: hashlib.sha256(b).hexdigest() == sums.get(n) for n, b in data.items() if n != 'SHA256SUMS'}
    expected = set(asset_names(tag)) | {'SHA256SUMS'}
    members = {}
    with tarfile.open(fileobj=io.BytesIO(data[f'trustbench-{v}-source.tar.gz'])) as t:
        for m in t.getmembers():
            if m.isfile():
                members[m.name] = t.extractfile(m).read()
    tagged = set(git('ls-tree', '-r', '--name-only', tag).split())
    in_archive = {n.split('/', 1)[1] for n in members}
    problems = scan(members) + scan({n: b for n, b in data.items() if not n.endswith('.tar.gz')})
    quick = run_quickstart(v, next(a['url'] for a in rel['assets'] if a['name'].endswith('source.tar.gz')), None)
    out = {'task_id': 'TB-053', 'tag': tag, 'release_url': rel['url'], 'commit': git('rev-list', '-n', '1', tag).strip(), 'checked_at': now(),
           'assets': sorted(data), 'missing_assets': sorted(expected - set(data)), 'checksums_match': checksum,
           'archive': {'files': len(members), 'equals_tagged_tree': in_archive == tagged, 'has_license': 'LICENSE' in in_archive,
                       'has_notices': 'THIRD_PARTY_NOTICES.md' in in_archive, 'agentdojo_checkout_included': any(n.startswith('data/vendor/') for n in in_archive)},
           'secret_scan_problems': problems, 'quickstart': quick}
    out['ok'] = (not out['missing_assets'] and all(checksum.values()) and out['archive']['equals_tagged_tree'] and out['archive']['has_license']
                 and not out['archive']['agentdojo_checkout_included'] and not problems and quick['ok'])
    OUT.write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps({k: out[k] for k in ('ok', 'release_url', 'missing_assets', 'secret_scan_problems')} | {'checksums': all(checksum.values()), 'quickstart': quick['ok']}, indent=1))
    sys.exit(0 if out['ok'] else 1)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['quickstart']:
        src = Path(a[a.index('--source') + 1]).resolve()
        r = run_quickstart(a[a.index('--version') + 1] if '--version' in a else '0.0.0', str(src), src.parent)
        print(json.dumps(r, indent=1)); sys.exit(0 if r['ok'] else 1)
    if len(a) >= 3 and a[1] == '--tag' and a[0] in ('build', 'publish', 'verify'):
        {'build': build, 'publish': publish, 'verify': verify}[a[0]](a[2])
    else:
        sys.exit(__doc__)
