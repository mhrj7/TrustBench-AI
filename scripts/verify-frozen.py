#!/usr/bin/env python3
"""TB-031 guard: the frozen holdout configuration has not drifted. Every file in configs/frozen/MANIFEST.sha256 must still
have its recorded hash, every frozen runtime-settings copy must equal the live config file it was copied from, and the
selection must be the top-ranked eligible candidate of a run that touched no holdout fixture. Exits non-zero on any drift."""
import hashlib, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sel = json.loads((ROOT / 'configs/selection.yaml').read_text())
d = ROOT / sel['frozen_dir']
problems = []
for line in (d / 'MANIFEST.sha256').read_text().splitlines():
    sha, path = line.split('  ', 1)
    if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != sha:
        problems.append(f'changed since freezing: {path}')
cfg = json.loads((d / 'holdout-config.json').read_text())
for live, frozen in cfg['runtime_settings'].items():
    if (ROOT / live).read_bytes() != (ROOT / frozen).read_bytes():
        problems.append(f'live config differs from its frozen copy: {live} (a change after freezing needs a new amendment and selection)')
rec = json.loads((d / 'selection.json').read_text())
eligible = sorted((c for c in rec['candidates'] if c['status'] == 'eligible'), key=lambda c: c['rank'])
if not eligible or eligible[0]['system'] != rec['selected']['system'] or cfg['defended_system']['system'] != rec['selected']['system']:
    problems.append('frozen system is not the top-ranked eligible candidate')
if 'holdout fixtures excluded' not in rec['data']['split']:
    problems.append('selection record does not certify the holdout exclusion')
print(json.dumps({'ok': not problems, 'selected': rec['selected'], 'problems': problems}))
sys.exit(1 if problems else 0)
