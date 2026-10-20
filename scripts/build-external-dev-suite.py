#!/usr/bin/env python3
"""TB-059: the development suite for the external agent.

Every development fixture (data/splits.json groups with split "tuning") gets at least one case:

- cases already authored in the core suites (tests/arms/smoke-cases.json and the stress suites) are reused unchanged;
  a case ID that appears in more than one suite must be identical everywhere, or the build fails;
- a benign fixture with no authored case gets one generated from its own oracle (the reference trajectory: read the
  allowed sources, then write the oracle's note or draft), and is marked "generated_from_oracle".

Sealed fixtures (holdout_manifest, holdout2_manifest) are never included; the build fails if a source suite would add
one. Writes tests/external/fixtures/dev-suite.json; --check verifies the file is current.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/external/fixtures/dev-suite.json'
SOURCES = ['tests/arms/smoke-cases.json', 'tests/arms/stress-cases.json', 'tests/arms/stress-v2-cases.json', 'tests/arms/stress-v3-cases.json']


def oracle_case(fixture: dict) -> dict:
    contract, oracle = fixture['task_contract'], fixture['oracle']
    if oracle['kind'] == 'research_note':
        steps = [{'tool': 'read_document', 'arguments': {'resource_id': d}} for d in contract['allowed_document_ids']]
        steps.append({'tool': 'save_research_note', 'arguments': {k: oracle[k] for k in ('note_id', 'answer', 'citation_document_ids', 'abstained')}})
        final = f"Succeeded: research note {oracle['note_id']} saved."
    elif oracle['kind'] == 'email_draft':
        steps = [{'tool': 'lookup_contact', 'arguments': {'resource_id': contract['recipient_id']}}]
        steps += [{'tool': 'read_reference', 'arguments': {'resource_id': d}} for d in contract['reference_document_ids']]
        steps.append({'tool': 'create_email_draft', 'arguments': {'draft_id': oracle['draft_id'], 'recipient_id': oracle['recipient_id'], 'subject': oracle['subject'],
                      'body': 'Summary: ' + '; '.join(oracle['required_body_fragments']) + '.', 'idempotency_key': oracle['idempotency_key']}})
        final = f"Succeeded: local draft {oracle['draft_id']} created, not sent."
    else:
        raise SystemExit(f"{fixture['fixture_id']}: no oracle trajectory for kind {oracle['kind']}; author a case instead")
    return {'case_id': f"dev-{fixture['fixture_id'].lower()}", 'kind': 'benign', 'fixture_id': fixture['fixture_id'], 'attack_id': None,
            'steps': steps, 'final_text': final, 'generated_from_oracle': True}


def build() -> dict:
    splits = json.loads((ROOT / 'data/splits.json').read_text())
    dev = sorted({f for g in splits['groups'] if g['split'] == 'tuning' for f in g['fixture_ids']})
    sealed = {f for k in ('holdout_manifest', 'holdout2_manifest') if splits.get(k) for f in splits[k]['fixture_ids']}
    benign = {json.loads(l)['fixture_id']: json.loads(l) for l in (ROOT / 'data/benign.jsonl').read_text().splitlines() if l.strip()}
    cases: dict[str, dict] = {}
    sources: dict[str, list[str]] = {}
    for src in SOURCES:
        for c in json.loads((ROOT / src).read_text())['cases']:
            ids = {c['fixture_id'].split('--')[0], *([c['attack_id']] if c.get('attack_id') else [])}
            if ids & sealed:
                raise SystemExit(f'{src} {c["case_id"]} uses a sealed fixture')
            if not ids <= set(dev):
                continue
            if c['case_id'] in cases and cases[c['case_id']] != c:
                raise SystemExit(f'case {c["case_id"]} differs between suites')
            cases.setdefault(c['case_id'], c)
            sources.setdefault(c['case_id'], []).append(src)
    covered = {x for c in cases.values() for x in (c['fixture_id'].split('--')[0], c.get('attack_id')) if x}
    for fid in dev:
        if fid not in covered:
            if fid not in benign:
                raise SystemExit(f'attack fixture {fid} has no authored case')
            c = oracle_case(benign[fid])
            cases[c['case_id']] = c
            sources[c['case_id']] = ['generated from the fixture oracle']
    covered = {x for c in cases.values() for x in (c['fixture_id'].split('--')[0], c.get('attack_id')) if x}
    assert covered == set(dev), sorted(set(dev) ^ covered)
    return {'schema_version': '1.0.0',
            'note': 'TB-059 development suite for the external agent: every development (tuning) fixture, built by scripts/build-external-dev-suite.py from the core suites; benign fixtures without an authored case use a trajectory generated from their oracle. No sealed fixture.',
            'development_fixture_ids': dev, 'case_sources': sources, 'cases': sorted(cases.values(), key=lambda c: c['case_id'])}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    text = json.dumps(build(), indent=1) + '\n'
    if ap.parse_args().check:
        ok = OUT.exists() and OUT.read_text() == text
        print('dev suite current' if ok else f'{OUT.relative_to(ROOT)} is out of date: run scripts/build-external-dev-suite.py')
        return 0 if ok else 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    d = json.loads(text)
    print(json.dumps({'cases': len(d['cases']), 'development_fixtures': len(d['development_fixture_ids'])}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
