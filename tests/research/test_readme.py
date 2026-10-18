"""TB-050: a fresh user can follow the README without hidden local files."""
import json, runpy, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/check-readme.py'


def run_static(readme: str) -> list[str]:
    ns = runpy.run_path(str(SCRIPT), run_name='readme')
    ns['static'].__globals__['README'] = readme
    return ns['static']()


def test_every_path_script_command_flag_key_model_and_limit_in_the_readme_exists():
    assert run_static((ROOT / 'README.md').read_text()) == []


def test_the_static_check_catches_each_kind_of_broken_instruction():
    readme = (ROOT / 'README.md').read_text()
    broken = readme + '\nSee `docs/no-such-file.md`, run `npm run no-such-script`, and `sh bin/trustbench remote run --no-such-flag`.\n'
    problems = run_static(broken)
    assert any('docs/no-such-file.md' in p for p in problems)
    assert any('no-such-script' in p for p in problems)
    assert any('--no-such-flag' in p for p in problems)
    wrong_limit = readme.replace('| 34 paired runs |', '| 99 paired runs |')
    assert any('does not match the configs' in p for p in run_static(wrong_limit))
    assert any('absolute path' in p for p in run_static(readme + '\nRun `/Volumes/SomeDrive/TrustBench-AI/bin/trustbench`.\n'))


def test_the_fresh_clone_check_passed_on_exactly_this_readme():
    ev = json.loads((ROOT / 'evidence/tb050-readme-check.json').read_text())
    assert ev['ok'] and ev['install_ok'] and not ev['problems']
    assert 'fresh clone from GitHub' in ev['environment'] and 'non-root' in ev['environment']
    at_commit = subprocess.run(['git', 'show', f"{ev['commit']}:README.md"], cwd=ROOT, capture_output=True, text=True).stdout
    assert at_commit == (ROOT / 'README.md').read_text(), 'README changed since the fresh-clone check: run scripts/check-readme.py --fresh'
    cmds = {c['command']: c for c in ev['checks']}
    for c in ('sh bin/trustbench validate', 'sh bin/trustbench smoke --check', 'sh bin/trustbench manifest', 'sh bin/trustbench report --check'):
        assert cmds[c]['exit_code'] == 0 and all(cmds[c]['expected_found'].values()), c
    assert cmds['sh bin/trustbench benchmark dev-frozen']['exit_code'] != 0
