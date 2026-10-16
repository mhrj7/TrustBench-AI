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
rel_path = d / 'reliability.json'
if not rel_path.exists():
    problems.append('no reliability decision (configs/frozen/reliability.json, A-024)')
else:
    rel = json.loads(rel_path.read_text())
    if rel.get('combined_confirmation_required'):
        problems.append('reliability changes need the combined confirmation run before freezing (A-024)')
    hrel = cfg.get('reliability') or {}
    if rel['chosen_changes'] and not (d / 'reliability-override.json').exists():
        problems.append('reliability changes were chosen but the override file is missing')
    if bool(rel['chosen_changes']) != bool(hrel.get('changes')):
        problems.append('holdout-config.json does not carry the reliability decision')
    if rel['condition']['system'] != rec['selected']['system'] or rel['condition']['model'] != rec['selected']['model']:
        problems.append('reliability sweep ran a different system or model than the frozen selection')
print(json.dumps({'ok': not problems, 'selected': rec['selected'], 'problems': problems}))
sys.exit(1 if problems else 0)
