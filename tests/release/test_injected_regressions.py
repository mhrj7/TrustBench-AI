"""TB-038 acceptance (A-028): injected functional and security regressions block the release; an unmodified candidate passes.

Each test checks out the committed code in a temporary git worktree, injects one realistic bug into the candidate, and runs
Tier 1 of the gate (scripts/release-gate-scripted.py) from this trusted checkout against the baselines committed at HEAD."""
import json, subprocess, sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / 'scripts/release-gate-scripted.py'

# (name, file, original text, injected text, the blocking finding the gate must report)
INJECTIONS = [
    ('security: contract resource check removed', 'src/policy/capabilities.py', "            raise ValueError('resource_denied')", '            pass',
     'security regressions'),
    ('security: contract argument binding removed', 'src/policy/capabilities.py',
     "        if any(clean.get(k)!=v for k,v in expected.items()):raise ValueError('argument_scope_denied')", '        pass', 'security regressions'),
    ('functional: email draft tool loses the body', 'src/tools/app.py', '        draft = request.model_dump()',
     "        draft = request.model_dump(); draft['body'] = ''", 'functional regressions'),
    ('functional: gateway over-blocks research notes', 'src/gateway/app.py',
     "'tool_not_allowed' if 'tool_allowlist' not in self.disabled and tool_name not in binding.allowed_tools else None)",
     "'tool_not_allowed' if tool_name == 'save_research_note' or ('tool_allowlist' not in self.disabled and tool_name not in binding.allowed_tools) else None)",
     'functional regressions'),
]


@pytest.fixture()
def candidate(tmp_path):
    wt = tmp_path / 'candidate'
    subprocess.run(['git', 'worktree', 'add', '--detach', str(wt), 'HEAD'], cwd=ROOT, check=True, capture_output=True)
    for shared in ('node_modules', '.venv-tools'):
        (wt / shared).symlink_to(ROOT / shared)
    yield wt
    subprocess.run(['git', 'worktree', 'remove', '--force', str(wt)], cwd=ROOT, capture_output=True)


def gate(wt: Path, out: Path):
    p = subprocess.run([sys.executable, str(GATE), '--root', str(wt), '--baseline-ref', 'HEAD', '--out', str(out)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    return p.returncode, json.loads(out.read_text())


def test_unmodified_candidate_passes(candidate, tmp_path):
    code, record = gate(candidate, tmp_path / 'gate.json')
    assert code == 0 and record['outcome'] == 'PASS', record['blocking']


@pytest.mark.parametrize('name,path,original,injected,finding', INJECTIONS, ids=[i[0] for i in INJECTIONS])
def test_injected_regression_blocks_the_release(candidate, tmp_path, name, path, original, injected, finding):
    f = candidate / path
    text = f.read_text()
    assert text.count(original) == 1, f'injection site moved in {path}'
    f.write_text(text.replace(original, injected))
    code, record = gate(candidate, tmp_path / 'gate.json')
    assert code == 1 and record['outcome'] == 'FAIL'
    assert any(finding in b for b in record['blocking']), record['blocking']


def test_a_candidate_cannot_hide_a_regression_by_editing_its_own_baseline(candidate, tmp_path):
    name, path, original, injected, finding = INJECTIONS[1]
    f = candidate / path
    f.write_text(f.read_text().replace(original, injected))
    # The candidate also rewrites its committed baseline to match the regressed behaviour; the gate reads baselines from
    # the trusted checkout's git history at the baseline ref, so the edit has no effect.
    import shutil
    report = json.loads((ROOT / 'configs/release-gate.yaml').read_text())['scripted']['arm_baselines'][0]['report']
    (candidate / report).write_text('{"cases": []}')
    code, record = gate(candidate, tmp_path / 'gate.json')
    assert code == 1 and any(finding in b for b in record['blocking'])
