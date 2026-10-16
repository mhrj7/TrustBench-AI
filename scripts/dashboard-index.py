#!/usr/bin/env python3
"""TB-030: write the versioned run-store index for the review dashboard (configs/dashboard.yaml, index_file): every live
evidence report, its span file and the attribution file, each with its SHA-256, plus the store version over them all.
--check exits non-zero when the files on disk no longer match the committed index."""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.store import build_index, load_config, load_runs, verify_index  # noqa: E402

cfg = load_config()
path = ROOT / cfg['index_file']
if '--check' in sys.argv:
    problems = verify_index(json.loads(path.read_text()), cfg)
    print(json.dumps({'index': cfg['index_file'], 'ok': not problems, 'problems': problems}, indent=1))
    sys.exit(1 if problems else 0)
index = build_index(cfg)
runs = load_runs(index, cfg)
ids = [r['run_id'] for r in runs]
assert len(ids) == len(set(ids)), 'run IDs are not unique'
index['runs'] = len(runs)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(index, indent=1) + '\n')
print(json.dumps({'index': cfg['index_file'], 'store_version': index['store_version'], 'reports': sum(e['kind'] == 'report' for e in index['entries']),
                  'span_files': sum(e['kind'] == 'spans' for e in index['entries']), 'runs': len(runs)}))
