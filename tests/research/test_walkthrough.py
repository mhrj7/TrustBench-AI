"""TB-049: the walkthrough's examples are real recorded runs chosen by fixed rules, and every result has its evidence."""
import json, re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
W = json.loads((ROOT / 'evidence/tb049-walkthrough.json').read_text())


def examples():
    return [W['benign_run'], W['blocked_attack']['defended'], W['blocked_attack']['paired_undefended'], W['failure']]


def test_every_example_resolves_to_the_same_run_in_its_committed_raw_report():
    # The site's run store (web/public/data) is generated from these reports and is not committed; check the source.
    for x in examples():
        report = json.loads((ROOT / x['report']).read_text())
        _, cases, i, arm = x['pointer'].split('/')
        case = report[cases][int(i)]
        assert (case['case_id'], case['repetition'], arm) == (x['case_id'], x['repetition'], x['arm'])
        ev = case[arm]['evaluation']
        assert (ev['utility_pass'], ev['security_pass'], ev['attacker_goal_achieved']) == (x['utility_pass'], x['security_pass'], x['attacker_goal_achieved'])
        assert [t['tool'] for t in case[arm]['tool_trace']] == [t['tool'] for t in x['tool_calls']]
        assert unquote(x['site_path'].split('/runs/', 1)[1]) == x['run_id'] and x['run_id'].endswith(f"|{x['case_id']}|r{x['repetition']}|{arm}")


def test_each_example_meets_its_selection_rule():
    b, d, u, f = examples()
    assert b['kind'] == 'benign' and b['utility_pass'] and b['outcome'] == 'success' and b['denied_calls'] == 0
    assert d['kind'] == 'attack' and d['security_pass'] and d['denied_calls'] >= 1
    assert u['arm'] == 'baseline' and u['attacker_goal_achieved'] and not u['security_pass']
    assert (d['case_id'], d['repetition']) == (u['case_id'], u['repetition'])
    assert f['kind'] == 'benign' and not f['utility_pass'] and f['arm'] == 'defended'
    assert all(v is True for v in d['parity'].values())


def test_the_release_gate_example_passes_unmodified_and_blocks_the_injected_regression():
    g = W['release_gate']
    assert g['unmodified']['outcome'] == 'PASS' and g['unmodified']['exit_code'] == 0
    assert g['injected']['outcome'] == 'FAIL' and g['injected']['exit_code'] == 1
    assert any(g['injection']['expected_finding'] in b for b in g['injected']['blocking'])


def test_every_live_site_mode_was_run_from_the_cli_and_no_key_was_recorded():
    runs = {r['mode']: r for r in W['cli']['runs']}
    for mode in ('instant (no model, no key)', 'live, project key', 'live, your own key'):
        assert runs[mode]['exit_code'] == 0 and runs[mode]['summary']['status'] == 'done', mode
    assert runs['download the report']['exit_code'] == 0 and runs['download the report']['summary']['report_cases'] > 0
    secret = [re.compile(p) for p in json.loads((ROOT / 'configs/repro.yaml').read_text())['secret_patterns']]
    for path in ('evidence/tb049-cli-transcript.txt', 'evidence/tb049-walkthrough.json', 'docs/media/walkthrough-steps.json'):
        text = (ROOT / path).read_text()
        assert not any(r.search(text) for r in secret), path


def test_the_video_exists_and_its_captions_describe_the_chosen_runs():
    video = ROOT / 'docs/media/walkthrough.webm'
    assert video.read_bytes()[:4] == b'\x1aE\xdf\xa3'  # WebM (Matroska/EBML) header
    steps = json.loads((ROOT / 'docs/media/walkthrough-steps.json').read_text())['steps']
    captions = ' '.join(s['caption'] for s in steps)
    for x in (W['benign_run'], W['failure']):
        assert f"{x['case_id']} r{x['repetition']}" in captions
    assert 'Not filled in for this recording' in captions, 'the own-key form is shown, never filled'
    assert [s['at_s'] for s in steps] == sorted(s['at_s'] for s in steps)


def test_the_architecture_doc_has_the_trust_boundary_diagram_and_each_example():
    text = (ROOT / 'docs/architecture.md').read_text()
    assert '```mermaid' in text and 'Capability gateway' in text
    for heading in ('### A benign run', '### A blocked attack', '### A failure trace', '### A release-gate example', '## Walkthrough of the live site'):
        assert heading in text
