"""TB-042: the backup tool restores exactly what it saved, refuses damaged backups, and snapshots databases consistently."""
import json, sqlite3, subprocess, sys, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / 'scripts/backup.py'


def run(*args):
    p = subprocess.run([sys.executable, str(TOOL), *map(str, args)], capture_output=True, text=True, timeout=300)
    return p.returncode, json.loads(p.stdout.strip().splitlines()[-1]) if p.stdout.strip() else {'stderr': p.stderr}


def make_state(d: Path):
    (d / 'jobs' / 'abc123').mkdir(parents=True)
    (d / 'jobs' / 'abc123' / 'report.json').write_text('{"cases": [1, 2, 3]}')
    (d / 'jobs' / 'abc123' / 'policy-traces.jsonl').write_text('{"seq": 0, "decision": "deny"}\n')
    db = sqlite3.connect(d / 'sessions.sqlite'); db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE s (k TEXT PRIMARY KEY, v TEXT)'); db.executemany('INSERT INTO s VALUES (?, ?)', [(f'k{i}', 'v') for i in range(100)]); db.commit(); db.close()


def test_round_trip_restores_every_file_and_row(tmp_path):
    src, bk, dst = tmp_path / 'src', tmp_path / 'bk', tmp_path / 'dst'
    src.mkdir(); make_state(src)
    code, b = run('backup', '--source', src, '--dest', bk, '--label', 'test')
    assert code == 0 and b['files'] == 3 and b['databases'] == 1
    code, r = run('restore', '--backup', bk, '--dest', dst)
    assert code == 0 and r['ok'] and r['problems'] == []
    assert (dst / 'jobs/abc123/report.json').read_text() == (src / 'jobs/abc123/report.json').read_text()
    assert sqlite3.connect(dst / 'sessions.sqlite').execute('SELECT COUNT(*) FROM s').fetchone()[0] == 100


def test_a_damaged_backup_is_refused(tmp_path):
    src, bk = tmp_path / 'src', tmp_path / 'bk'
    src.mkdir(); make_state(src); run('backup', '--source', src, '--dest', bk)
    f = bk / 'data/jobs/abc123/policy-traces.jsonl'
    f.write_text(f.read_text().replace('deny', 'allow'))  # one altered audit record
    code, r = run('restore', '--backup', bk, '--dest', tmp_path / 'dst')
    assert code == 1 and not r['ok'] and r['refused'] == 'backup failed verification' and any('policy-traces' in p for p in r['problems'])
    assert not (tmp_path / 'dst').exists(), 'nothing is restored from a damaged backup'


def test_an_edited_manifest_is_refused(tmp_path):
    src, bk = tmp_path / 'src', tmp_path / 'bk'
    src.mkdir(); make_state(src); run('backup', '--source', src, '--dest', bk)
    m = json.loads((bk / 'MANIFEST.json').read_text()); m['files'] = m['files'][:1]
    (bk / 'MANIFEST.json').write_text(json.dumps(m))
    code, v = run('verify', '--backup', bk)
    assert code == 1 and v['problems'] == ['manifest hash mismatch']


def test_a_database_being_written_is_snapshotted_consistently(tmp_path):
    src, bk, dst = tmp_path / 'src', tmp_path / 'bk', tmp_path / 'dst'
    src.mkdir(); make_state(src)
    stop = threading.Event()
    def writer():
        db = sqlite3.connect(src / 'sessions.sqlite', timeout=10); i = 1000
        while not stop.is_set():
            db.execute('INSERT INTO s VALUES (?, ?)', (f'k{i}', 'v')); db.commit(); i += 1
        db.close()
    t = threading.Thread(target=writer); t.start(); time.sleep(0.2)
    try:
        code, _ = run('backup', '--source', src, '--dest', bk)
    finally:
        stop.set(); t.join()
    assert code == 0 and run('restore', '--backup', bk, '--dest', dst)[1]['ok']
    rows = sqlite3.connect(dst / 'sessions.sqlite').execute('SELECT COUNT(*) FROM s').fetchone()[0]
    assert rows >= 100  # a committed state at the moment of the snapshot, never a torn file


def test_replace_keeps_the_existing_directory_aside(tmp_path):
    src, bk, dst = tmp_path / 'src', tmp_path / 'bk', tmp_path / 'dst'
    src.mkdir(); make_state(src); run('backup', '--source', src, '--dest', bk)
    dst.mkdir(); (dst / 'newer.txt').write_text('written after the backup')
    assert run('restore', '--backup', bk, '--dest', dst)[1]['refused'].endswith('(use --replace)')
    code, r = run('restore', '--backup', bk, '--dest', dst, '--replace')
    assert code == 0 and r['ok'] and Path(r['kept_aside'], 'newer.txt').read_text() == 'written after the backup'
