#!/usr/bin/env python3
"""TB-064: the external case suites. For every family that data/external-splits.json assigns to external_validation
(TB-061 procedure, frozen in TB-062): an attack case, and a benign case for its benign twin, written as two suites
(benign, attack) so each attack rendering is scheduled without repeating the benign units. The tuning families get one
combined suite, used only to set up and check the live path before the registered pass. No suite mixes the two
assignments. Each case carries the reference trajectory (src/arms/external_trajectories.py) for scripted runs; live
runs use only the fixture. Every suite records the external manifest hash it was built against.

usage: build-external-validation-suite.py [--check]
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.arms.external_trajectories import reference_steps  # noqa: E402

DATA = ROOT / 'data'
lines = lambda p: [json.loads(l) for l in (DATA / p).read_text().splitlines() if l.strip()]
SHORT = {'document_evidence_analyst': 'doc', 'email_draft_assistant': 'email', 'controlled_record_update': 'update'}


def build(assignment):
    split = json.loads((DATA / 'external-splits.json').read_text())
    manifest = json.loads((DATA / 'external-manifest.json').read_text())
    for rel, digest in manifest['files'].items():
        if hashlib.sha256((ROOT / rel).read_bytes()).hexdigest() != digest:
            raise SystemExit(f'refused: {rel} differs from the frozen external manifest')
    assigned = {f['family_id']: f for f in split['families'] if f['assignment'] == assignment}
    benign = {b['fixture_id']: b for b in lines('external-benign.jsonl')}
    cases = []
    for a in sorted(lines('external-attacks.jsonl'), key=lambda a: a['attack_id']):
        fam = assigned.get(a['family_id'])
        if not fam:
            continue
        b = benign[a['base_fixture_id']]
        stem = f"ext-{SHORT[a['workflow']]}-{a['family_id'].removeprefix('family-')}"
        meta = {'family_id': a['family_id'], 'family_status': fam['family_status'], 'workflow': a['workflow']}
        steps = reference_steps(b)
        cases.append({'case_id': f'{stem}-benign', 'kind': 'benign', 'fixture_id': b['fixture_id'], 'attack_id': None, **meta,
                      'steps': steps, 'final_text': 'Succeeded: task completed.'})
        cases.append({'case_id': f'{stem}-attack', 'kind': 'attack', 'fixture_id': f"{b['fixture_id']}--{a['attack_id']}", 'attack_id': a['attack_id'], **meta,
                      'steps': steps, 'final_text': 'Succeeded: task completed.'})
    if {c['family_id'] for c in cases} != set(assigned):
        raise SystemExit('refused: an external-validation family has no attack fixture')
    return cases, {'schema_version': '1.0.0', 'task_id': 'TB-064', 'fixture_set': 'external', 'assignment': assignment,
                   'external_split_sha256': split['sha256'], 'external_manifest_sha256': hashlib.sha256((DATA / 'external-manifest.json').read_bytes()).hexdigest()}


OUT = ROOT / 'tests/external/evaluation'
NOTE = 'Built by scripts/build-external-validation-suite.py from data/external-splits.json; do not edit.'


def suites():
    ev, head = build('external_validation')
    tu, thead = build('tuning')
    return {
        'external-validation-benign.json': {**head, 'note': 'External-validation benign twins. ' + NOTE, 'cases': [c for c in ev if c['kind'] == 'benign']},
        'external-validation-attack.json': {**head, 'note': 'External-validation attack cases. ' + NOTE, 'cases': [c for c in ev if c['kind'] == 'attack']},
        'external-tuning.json': {**thead, 'note': 'Tuning families (attack and twin), for setting up the live path only. ' + NOTE, 'cases': tu},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    bad = []
    for name, doc in suites().items():
        text = json.dumps(doc, indent=1) + '\n'
        if a.check:
            if not (OUT / name).exists() or (OUT / name).read_text() != text:
                bad.append(name)
        else:
            (OUT / name).write_text(text)
            print(name, len(doc['cases']))
    if a.check:
        print('external suites current' if not bad else f'external suites differ from the builder: {bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
