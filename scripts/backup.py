#!/usr/bin/env python3
"""TB-042: back up and restore TrustBench state directories (the live-test service's data, a durable run store, run and
audit artifacts), with a verified manifest.

  backup.py backup  --source DIR --dest BACKUP_DIR [--label TEXT]
  backup.py verify  --backup BACKUP_DIR
  backup.py restore --backup BACKUP_DIR --dest DIR [--replace]

Backup: every SQLite database is copied through SQLite's online backup API (a consistent snapshot even while a writer is
active; its -wal and -shm files are folded in, not copied), every other file byte for byte. MANIFEST.json lists each file
with its SHA-256, size and kind, plus the repository commit and the time; the manifest's own SHA-256 is written beside it.
Verify: the manifest matches its hash, every listed file exists with its recorded hash, nothing unlisted is present, and every
database passes `PRAGMA integrity_check`. Restore: verifies first and refuses a backup that fails; refuses a non-empty
destination unless --replace, in which case the existing directory is kept aside as DIR.pre-restore-<time> (never deleted);
copies, then verifies the restored tree against the manifest. Prints a JSON summary with timings."""
import argparse, hashlib, json, os, shutil, sqlite3, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQLITE_MAGIC = b'SQLite format 3\x00'
SIDE_FILES = ('-wal', '-shm', '-journal')


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def is_sqlite(path: Path) -> bool:
    try:
        with open(path, 'rb') as f:
            return f.read(16) == SQLITE_MAGIC
    except OSError:
        return False


def commit() -> str | None:
    out = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True)
    return out.stdout.strip() or None


def integrity(path: Path) -> str:
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    try:
        return db.execute('PRAGMA integrity_check').fetchone()[0]
    finally:
        db.close()


def backup(source: Path, dest: Path, label: str | None) -> dict:
    t0 = time.perf_counter()
    if dest.exists() and any(dest.iterdir()):
        sys.exit(f'backup destination {dest} is not empty')
    (dest / 'data').mkdir(parents=True, exist_ok=True)
    files = []
    for p in sorted(source.rglob('*')):
        if not p.is_file() or p.name.endswith(SIDE_FILES):
            continue
        rel = p.relative_to(source)
        out = dest / 'data' / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        if is_sqlite(p):
            src, dst = sqlite3.connect(p), sqlite3.connect(out)
            try:
                src.backup(dst)  # online, consistent snapshot including committed WAL content
            finally:
                dst.close(); src.close()
            kind = 'sqlite'
        else:
            shutil.copy2(p, out)
            kind = 'file'
        os.chmod(out, p.stat().st_mode & 0o777)
        files.append({'path': str(rel), 'kind': kind, 'size': out.stat().st_size, 'sha256': sha256(out)})
    manifest = {'format': 'trustbench-backup/1', 'label': label, 'source': str(source), 'commit': commit(),
                'created_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'files': files}
    text = json.dumps(manifest, indent=1, sort_keys=True) + '\n'
    (dest / 'MANIFEST.json').write_text(text)
    (dest / 'MANIFEST.sha256').write_text(hashlib.sha256(text.encode()).hexdigest() + '\n')
    return {'action': 'backup', 'files': len(files), 'databases': sum(f['kind'] == 'sqlite' for f in files),
            'bytes': sum(f['size'] for f in files), 'seconds': round(time.perf_counter() - t0, 3), 'backup': str(dest)}


def check_tree(tree: Path, manifest: dict) -> list[str]:
    problems = []
    listed = {f['path'] for f in manifest['files']}
    for f in manifest['files']:
        p = tree / f['path']
        if not p.is_file():
            problems.append(f'missing: {f["path"]}')
        elif sha256(p) != f['sha256']:
            problems.append(f'hash mismatch: {f["path"]}')
        elif f['kind'] == 'sqlite' and integrity(p) != 'ok':
            problems.append(f'integrity check failed: {f["path"]}')
    for p in tree.rglob('*'):
        if p.is_file() and not p.name.endswith(SIDE_FILES) and str(p.relative_to(tree)) not in listed:
            problems.append(f'unlisted file: {p.relative_to(tree)}')
    return problems


def load_manifest(backup_dir: Path) -> tuple[dict | None, list[str]]:
    try:
        text = (backup_dir / 'MANIFEST.json').read_text()
        recorded = (backup_dir / 'MANIFEST.sha256').read_text().strip()
    except OSError as e:
        return None, [f'manifest unreadable: {e}']
    if hashlib.sha256(text.encode()).hexdigest() != recorded:
        return None, ['manifest hash mismatch']
    return json.loads(text), []


def verify(backup_dir: Path) -> dict:
    t0 = time.perf_counter()
    manifest, problems = load_manifest(backup_dir)
    if manifest:
        problems += check_tree(backup_dir / 'data', manifest)
    return {'action': 'verify', 'ok': not problems, 'problems': problems, 'files': len(manifest['files']) if manifest else 0,
            'seconds': round(time.perf_counter() - t0, 3)}


def restore(backup_dir: Path, dest: Path, replace: bool) -> dict:
    t0 = time.perf_counter()
    pre = verify(backup_dir)
    if not pre['ok']:
        return {'action': 'restore', 'ok': False, 'refused': 'backup failed verification', 'problems': pre['problems']}
    kept_aside = None
    if dest.exists() and any(dest.iterdir()):
        if not replace:
            return {'action': 'restore', 'ok': False, 'refused': f'{dest} is not empty (use --replace)'}
        kept_aside = dest.with_name(f'{dest.name}.pre-restore-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}')
        dest.rename(kept_aside)
    shutil.copytree(backup_dir / 'data', dest, dirs_exist_ok=True, copy_function=shutil.copy2)
    manifest, _ = load_manifest(backup_dir)
    post = check_tree(dest, manifest)
    return {'action': 'restore', 'ok': not post, 'problems': post, 'files': len(manifest['files']), 'kept_aside': str(kept_aside) if kept_aside else None,
            'seconds': round(time.perf_counter() - t0, 3), 'verify_seconds': pre['seconds'], 'backup_commit': manifest['commit']}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('backup'); b.add_argument('--source', required=True, type=Path); b.add_argument('--dest', required=True, type=Path); b.add_argument('--label')
    v = sub.add_parser('verify'); v.add_argument('--backup', required=True, type=Path)
    r = sub.add_parser('restore'); r.add_argument('--backup', required=True, type=Path); r.add_argument('--dest', required=True, type=Path); r.add_argument('--replace', action='store_true')
    a = ap.parse_args()
    result = backup(a.source, a.dest, a.label) if a.cmd == 'backup' else verify(a.backup) if a.cmd == 'verify' else restore(a.backup, a.dest, a.replace)
    print(json.dumps(result))
    sys.exit(0 if result.get('ok', True) else 1)


if __name__ == '__main__':
    main()
