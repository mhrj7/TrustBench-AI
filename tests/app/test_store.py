"""TB-030 versioned run store: the index pins every file by hash, a changed file is reported and its raw record refuses to
open, every run resolves to its own record, and spans attach only to the run they belong to."""
import copy
import json
from pathlib import Path

import pytest

from app.store import ROOT, build_index, load_config, load_runs, raw_record, run_id, run_spans, store_version, verify_index

CFG = load_config()
INDEX = json.loads((ROOT / CFG['index_file']).read_text())
RUNS = load_runs(INDEX, CFG)


def test_committed_index_matches_the_files_and_its_version():
    assert verify_index(INDEX, CFG) == []
    assert store_version(INDEX['entries']) == INDEX['store_version'] == build_index(CFG)['store_version']


def test_a_changed_file_is_reported_and_its_records_do_not_open():
    stale = copy.deepcopy(INDEX)
    entry = next(e for e in stale['entries'] if e['kind'] == 'report')
    entry['sha256'] = '0' * 64
    assert verify_index(stale, CFG) == [f"changed since indexing: {entry['path']}"]
    run = dict(next(r for r in RUNS if r['report'] == entry['path']), report_sha256='0' * 64)
    with pytest.raises(ValueError, match='changed since the store was indexed'):
        raw_record(run)
    missing = copy.deepcopy(INDEX)
    missing['entries'].append({'kind': 'report', 'path': 'evidence/does-not-exist-report.json', 'sha256': 'x'})
    assert 'missing since indexing: evidence/does-not-exist-report.json' in verify_index(missing, CFG)


def test_run_ids_are_unique_and_every_run_opens_to_its_own_record():
    assert len({r['run_id'] for r in RUNS}) == len(RUNS) == INDEX['runs']
    for r in RUNS[:: max(1, len(RUNS) // 200)]:
        rec = raw_record(r)
        assert run_id(r['report'], rec['case'], r['pointer'].rsplit('/', 1)[1]) == r['run_id']
        assert rec['source'] == {'report': r['report'], 'sha256': r['report_sha256'], 'pointer': r['pointer']}
        assert rec['run']['evaluation']['utility_pass'] == r['utility_pass']


def test_spans_attach_only_to_their_own_run():
    timed = [r for r in RUNS if r['spans_file']]
    assert timed and not run_spans(next(r for r in RUNS if not r['spans_file']))
    for r in timed[:20]:
        spans = run_spans(r)
        root = [s for s in spans if s['name'] == 'agent.run']
        assert len(root) == 1 and root[0]['attributes']['case.id'] == r['case_id'] and root[0]['attributes']['arm'] == r['arm']
        assert {s['attributes']['run.id'] for s in spans} == {f"run-{r['case_id']}-r{r['repetition']}:{r['arm']}"}
    wrong = dict(timed[0], case_id='no-such-case')
    assert run_spans(wrong) == []


def test_attribution_joins_only_failed_valid_runs():
    with_att = [r for r in RUNS if r['utility_rule'] or r['security_rule']]
    assert with_att and all(not r['invalid'] and not (r['utility_pass'] and r['security_pass']) for r in with_att)
