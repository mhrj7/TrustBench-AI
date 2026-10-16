#!/usr/bin/env python3
"""TB-032 (A-025): the confirmatory holdout suite, built from the sealed manifest IDs alone.

One live case per sealed fixture: each benign fixture as itself, each attack on its registered base fixture
(data/attacks.jsonl base_fixture_id, metadata only). No scripted steps: the suite is live-only. Writes the path
registered as holdout.confirmatory_suite in protocol/experiment-registry.yaml and refuses to overwrite a different one."""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
reg = json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())
manifest = json.loads((ROOT / reg['holdout']['split_manifest']).read_text())['holdout_manifest']
ids = manifest['fixture_ids']
benign_ids = {json.loads(l)['fixture_id'] for l in (ROOT / 'data/benign.jsonl').read_text().splitlines() if l.strip()}
base_of = {a['attack_id']: a['base_fixture_id'] for a in map(json.loads, filter(str.strip, (ROOT / 'data/attacks.jsonl').read_text().splitlines()))}

cases = []
for fid in sorted(ids):
    if fid in benign_ids:
        cases.append({'case_id': f'holdout-{fid.lower()}', 'kind': 'benign', 'fixture_id': fid, 'attack_id': None, 'live_only': True})
    elif fid in base_of:
        if base_of[fid] not in ids:
            sys.exit(f'{fid} has base fixture {base_of[fid]} outside the holdout manifest')
        cases.append({'case_id': f'holdout-{fid.lower()}', 'kind': 'attack', 'fixture_id': f'{base_of[fid]}--{fid}', 'attack_id': fid, 'live_only': True})
    else:
        sys.exit(f'manifest ID {fid} is neither a benign fixture nor an attack')

suite = {'schema_version': '1.0.0', 'note': 'TB-032 confirmatory holdout suite (A-025), built by scripts/build-holdout-suite.py from the sealed manifest IDs alone. Live runs only, through run-arm-smoke.mjs --confirmatory-holdout.',
         'manifest_sha256': manifest['sha256'], 'cases': cases}
out = ROOT / reg['holdout']['confirmatory_suite']
text = json.dumps(suite, indent=1) + '\n'
if out.exists() and out.read_text() != text:
    sys.exit(f'{out.relative_to(ROOT)} exists and differs; the holdout suite is built once')
out.write_text(text)
print(json.dumps({'suite': str(out.relative_to(ROOT)), 'cases': [(c['case_id'], c['kind']) for c in cases]}))
