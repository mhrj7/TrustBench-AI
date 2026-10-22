#!/usr/bin/env python3
"""TB-061 (amendment A-030): the registered split procedure for the external validation.

Assigns attack families, never individual fixtures, to `tuning` or `external_validation`. Input: a JSON list of
candidate families, each {"family_id", "workflow", "origin"} where origin is "new" (authored for TB-062) or "existing"
(already in data/splits.json). The rule, fixed by A-030 before any family is assigned:

1. Eligibility. A family used in any tuning group of data/splits.json is refused. A candidate may not carry fixtures:
   every fixture of the external validation is authored new, so no fixture of a sealed set (holdout_manifest,
   holdout2_manifest) can be reused; a candidate listing a sealed fixture ID is refused. An existing family that appears
   only in a sealed holdout is eligible and labelled `holdout_seen` (its holdout results were seen).
2. Stratification. Families are grouped by workflow (the three workflows of data/attacks.jsonl).
3. Seeded assignment. Within each workflow the eligible families are ordered by SHA-256 of "<seed>:<family_id>"; the
   first ceil(n * external_fraction) go to external_validation and the rest to tuning, with at least one family per
   workflow in external_validation.
4. No reassignment. If the manifest already exists, every family already in it keeps its assignment, and the run is
   refused if it was made with another seed or fraction, or if an assigned family is missing from the candidate list.
   New families fill each workflow's external quota in seed order without moving old ones.

Writes data/external-splits.json with the assignments, the rule parameters and a SHA-256 of its content. The parameters
come from protocol/experiment-registry.yaml `external_validation`; tests may override them and the output path.

usage: external-split.py --families <candidates.json> [--out data/external-splits.json] [--seed N] [--fraction F] [--check]
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ('document_evidence_analyst', 'email_draft_assistant', 'controlled_record_update')   # as in data/attacks.jsonl


class SplitError(Exception):
    pass


def registry():
    return json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())['external_validation']


def tuning_families(splits):
    return {f for g in splits['groups'] if g['split'] == 'tuning' for f in g.get('attack_family_ids', [])}


def sealed_fixtures(splits):
    return {f for k in ('holdout_manifest', 'holdout2_manifest') if splits.get(k) for f in splits[k]['fixture_ids']}


def holdout_families(splits):
    return {f for g in splits['groups'] if g['split'] in ('holdout', 'holdout2') for f in g.get('attack_family_ids', [])}


def content_sha256(doc):
    body = {k: v for k, v in doc.items() if k != 'sha256'}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def assign(candidates, splits, seed, fraction, existing=None):
    """Pure: the manifest for these candidates. Raises SplitError when the registered rule refuses."""
    tuning, sealed, seen = tuning_families(splits), sealed_fixtures(splits), holdout_families(splits)
    ids = [c['family_id'] for c in candidates]
    if len(set(ids)) != len(ids):
        raise SplitError('duplicate family IDs in the candidate list')
    for c in candidates:
        if c.get('workflow') not in WORKFLOWS:
            raise SplitError(f'{c["family_id"]}: workflow must be one of {WORKFLOWS}')
        if c.get('origin') not in ('new', 'existing'):
            raise SplitError(f'{c["family_id"]}: origin must be new or existing')
        if c['family_id'] in tuning:
            raise SplitError(f'{c["family_id"]} was used in tuning (data/splits.json) and is not eligible')
        if c.get('fixture_ids'):
            bad = sorted(set(c['fixture_ids']) & sealed)
            raise SplitError(f'{c["family_id"]}: candidates carry no fixtures; ' + (f'{bad} are sealed holdout fixtures' if bad else 'fixtures are authored new in TB-062'))
        if c['origin'] == 'existing' and c['family_id'] not in seen:
            raise SplitError(f'{c["family_id"]}: origin existing, but it is in no group of data/splits.json')
        if c['origin'] == 'new' and (c['family_id'] in seen or c['family_id'] in tuning):
            raise SplitError(f'{c["family_id"]}: origin new, but the family already exists')
    key = lambda fid: hashlib.sha256(f'{seed}:{fid}'.encode()).hexdigest()
    before = {}
    if existing:
        rule = existing['rule']
        if rule['seed'] != seed or rule['external_fraction'] != fraction:
            raise SplitError(f'refused: the manifest was made with seed {rule["seed"]} and fraction {rule["external_fraction"]}; other parameters would reassign families; a change needs a new amendment')
        before = {r['family_id']: r['assignment'] for r in existing['families']}
        missing = sorted(set(before) - set(ids))
        if missing:
            raise SplitError(f'refused: assigned families {missing} are missing from the candidate list')
    rows = []
    for wf in WORKFLOWS:
        fams = sorted((c for c in candidates if c['workflow'] == wf), key=lambda c: key(c['family_id']))
        if not fams:
            continue
        # Families already assigned keep their assignment; new ones fill the workflow's external quota in seed order.
        target = max(1, math.ceil(len(fams) * fraction))
        kept = sum(1 for c in fams if before.get(c['family_id']) == 'external_validation')
        free = max(0, target - kept)
        for c in fams:
            if c['family_id'] in before:
                assignment = before[c['family_id']]
            else:
                assignment = 'external_validation' if free > 0 else 'tuning'
                free -= assignment == 'external_validation'
            rows.append({'family_id': c['family_id'], 'workflow': wf, 'origin': c['origin'],
                         'family_status': 'holdout_seen' if c['family_id'] in seen else 'new',
                         'assignment': assignment, 'order_key': key(c['family_id'])})
    doc = {'schema_version': '1.0.0', 'amendment': 'A-030', 'rule': {'seed': seed, 'external_fraction': fraction, 'stratify_by': 'workflow',
           'order': 'sha256(seed:family_id)', 'minimum_external_per_workflow': 1}, 'families': sorted(rows, key=lambda r: (r['workflow'], r['order_key']))}
    doc['sha256'] = content_sha256(doc)
    return doc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--families', type=Path, required=True)
    ap.add_argument('--out', type=Path, default=ROOT / 'data/external-splits.json')
    ap.add_argument('--seed', type=int)
    ap.add_argument('--fraction', type=float)
    ap.add_argument('--check', action='store_true', help='verify the manifest is what the rule gives, without writing')
    a = ap.parse_args()
    reg = registry()
    seed = a.seed if a.seed is not None else reg['split_seed']
    fraction = a.fraction if a.fraction is not None else reg['external_fraction']
    splits = json.loads((ROOT / 'data/splits.json').read_text())
    candidates = json.loads(a.families.read_text())
    existing = json.loads(a.out.read_text()) if a.out.exists() else None
    if existing and existing.get('sha256') != content_sha256(existing):
        print('refused: the existing manifest was edited by hand (hash mismatch)', file=sys.stderr)
        return 1
    try:
        doc = assign(candidates, splits, seed, fraction, existing)
    except SplitError as e:
        print(str(e), file=sys.stderr)
        return 1
    if a.check:
        ok = existing is not None and existing['families'] == doc['families']
        print('external split current' if ok else 'external split differs from the registered rule')
        return 0 if ok else 1
    a.out.write_text(json.dumps(doc, indent=1) + '\n')
    print(json.dumps({'families': len(doc['families']), 'external_validation': sum(r['assignment'] == 'external_validation' for r in doc['families']), 'sha256': doc['sha256']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
