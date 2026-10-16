"""TB-032 (A-025): the confirmatory-holdout mode refuses non-frozen settings and creates nothing when it refuses."""
import json, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REG = json.loads((ROOT / 'protocol/experiment-registry.yaml').read_text())


def run(*args):
    return subprocess.run(['node', '--experimental-strip-types', '--no-warnings', 'scripts/run-arm-smoke.mjs', '--confirmatory-holdout', *args],
                          cwd=ROOT, capture_output=True, text=True, timeout=120)


def test_refuses_a_non_frozen_configuration_without_side_effects():
    before = sorted(p.name for p in (ROOT / REG['holdout']['confirmatory_run_dir']).glob('*')) if (ROOT / REG['holdout']['confirmatory_run_dir']).exists() else []
    p = run('--model', 'ollama:qwen3.5:9b', '--attack-rendering', 'as_authored', '--prompt-profile', 'hardened', '--suite', 'tests/arms/smoke-cases.json', '--work-dir', '.tool-state/holdout-guard-test')
    assert p.returncode != 0
    for reason in ('model must be', 'prompt profile must be', 'suite must be', 'TB-028 --schedule is required', 'reliability must be'):
        assert reason in p.stderr
    after = sorted(p.name for p in (ROOT / REG['holdout']['confirmatory_run_dir']).glob('*')) if (ROOT / REG['holdout']['confirmatory_run_dir']).exists() else []
    assert before == after


def test_schedule_builder_only_schedules_the_registered_holdout_suite(tmp_path):
    p = subprocess.run([str(ROOT / '.venv-tools/bin/python'), '-m', 'src.evaluation.repeats', 'schedule', '--suite', 'tests/arms/smoke-cases.json',
                        '--out', str(tmp_path / 's.json'), '--confirmatory-holdout'], cwd=ROOT, capture_output=True, text=True)
    assert p.returncode != 0 and 'registered holdout suite' in p.stderr


def test_suite_holds_exactly_the_sealed_manifest():
    suite = json.loads((ROOT / REG['holdout']['confirmatory_suite']).read_text())
    ids = set(json.loads((ROOT / 'data/splits.json').read_text())['holdout_manifest']['fixture_ids'])
    covered = {c['attack_id'] or c['fixture_id'] for c in suite['cases']}
    assert covered == ids and all('steps' not in c for c in suite['cases'])
