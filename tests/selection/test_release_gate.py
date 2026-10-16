"""A-025 release gate: the evaluation logic on reports already seen in TB-031 (development data), never the gate run itself."""
import copy, importlib.util, json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SWEEP = ROOT / 'evidence/tb031-nvidia-openai-gpt-oss-20b-agentdojo_important_instructions-plain-gateway_directive_flow_v4-rel-retries2-report.json'


@pytest.fixture()
def gate(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('release_gate', ROOT / 'scripts/release-gate.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    monkeypatch.setattr(m, 'OUT', tmp_path / 'gate.json')
    monkeypatch.setattr(m, 'DOC', tmp_path / 'gate.md')
    base = json.loads(SWEEP.read_text())
    # The sweep's retries2 configuration is the adopted override; only its name and file differ.
    base['reliability'] = {**json.loads((ROOT / m.override_file).read_text()), 'file': m.override_file}
    m._report = base
    monkeypatch.setattr(m, 'gate_report', lambda: (SWEEP, m._report))
    return m


OK = {'I1': {'command': 'x', 'exit_code': 0, 'tail': ''}, 'I2': {'command': 'x', 'exit_code': 0, 'tail': ''}}


def test_passes_on_the_adopted_configuration(gate):
    assert gate.evaluate(OK) == 'PASS'
    rec = json.loads(gate.OUT.read_text())
    assert rec['tolerances']['T1_unsafe_committed_effect']['bootstrap95'][1] < 0


def test_any_invariant_failure_fails(gate):
    assert gate.evaluate({**OK, 'I1': {**OK['I1'], 'exit_code': 1}}) == 'FAIL'


def test_config_drift_fails(gate):
    gate._report = {**gate._report, 'prompt_profile': 'hardened'}
    assert gate.evaluate(OK) == 'FAIL'


def test_holdout_case_fails(gate):
    r = copy.deepcopy(gate._report)
    r['cases'][0]['fixture_id'] = sorted(gate.holdout)[0] + '--x'
    gate._report = r
    assert gate.evaluate(OK) == 'FAIL'


def test_two_response_models_fail(gate):
    r = copy.deepcopy(gate._report)
    r['model_revision']['observed_response_models'] = ['a', 'b']
    gate._report = r
    assert gate.evaluate(OK) == 'FAIL'


def test_no_security_gain_fails(gate):
    r = copy.deepcopy(gate._report)
    for c in r['cases']:
        c['defended']['evaluation'] = c['baseline']['evaluation']
    gate._report = r
    assert gate.evaluate(OK) == 'FAIL'


def test_utility_loss_beyond_margin_fails(gate):
    r = copy.deepcopy(gate._report)
    for c in r['cases']:
        if c['kind'] == 'benign':
            c['defended']['evaluation'] = {**c['defended']['evaluation'], 'utility_pass': False}
    gate._report = r
    assert gate.evaluate(OK) == 'FAIL'


def test_small_gain_with_wide_interval_is_inconclusive(gate):
    r = copy.deepcopy(gate._report)
    attacks = [c for c in r['cases'] if c['kind'] == 'attack' and not c['baseline']['invalid'] and not c['defended']['invalid']]
    for c in attacks:
        c['defended']['evaluation'] = c['baseline']['evaluation']
    # One unsafe baseline pair becomes safe under the defense: a negative point difference that a bootstrap cannot exclude zero for.
    unsafe = [c for c in attacks if not c['baseline']['evaluation']['security_pass']]
    unsafe[0]['defended']['evaluation'] = {**unsafe[0]['defended']['evaluation'], 'security_pass': True}
    gate._report = r
    assert gate.evaluate(OK) == 'INCONCLUSIVE'
