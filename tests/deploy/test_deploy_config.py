"""TB-041: the demo deployment cannot ship or widen what it should not. Static checks of the build context, the compose
file and the deployment profiles; the built image itself is scanned by scripts/deploy-staging.sh."""
import fnmatch, json, os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
os.environ['TRUSTBENCH_SERVICE_NO_AUTOSTART'] = '1'


def ignored(path: str) -> bool:
    """Docker's rule: the last matching .dockerignore line wins; '!' re-includes."""
    verdict = False
    for line in (ROOT / '.dockerignore').read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        neg = line.startswith('!')
        pat = line[1:] if neg else line
        if fnmatch.fnmatch(path, pat) or fnmatch.fnmatch(path, pat.rstrip('/') + '/*') or fnmatch.fnmatch(path, '**/' + pat):
            verdict = not neg
    return verdict


@pytest.mark.parametrize('path', ['.env', '.env.local', '.env.production', 'deploy/secrets/nvidia_api_key', 'deploy/secrets/trustbench_admin_token',
                                  '.tool-state/x', 'node_modules/x'])
def test_secrets_and_local_state_never_enter_the_image(path):
    assert ignored(path), path


def test_the_example_env_still_reaches_the_build():
    assert not ignored('.env.example')


def test_compose_holds_no_secret_values_and_binds_loopback_only():
    text = (ROOT / 'deploy/compose.yaml').read_text()
    assert 'nvapi-' not in text and 'AIza' not in text
    assert '_FILE: /run/secrets/' in text and '127.0.0.1:' in text and 'read_only: true' in text and 'cap_drop: [ALL]' in text
    assert 'init: true' in text and 'restart: unless-stopped' in text  # signals forwarded, runner processes reaped, restarts itself
    assert 'CMD ["sh", "-c", "exec ' in (ROOT / 'Dockerfile.service').read_text()  # the server is the process that gets SIGTERM


def test_profiles_only_tighten_and_widening_is_refused():
    from src.service.app import CFG, apply_profile
    base = json.loads((ROOT / 'configs/live-service.yaml').read_text())
    for p in sorted((ROOT / 'configs/deploy').glob('*.json')):
        out = apply_profile(base, json.loads(p.read_text()))
        for mode, spec in out['modes'].items():
            for k, v in spec.items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    assert v <= base['modes'][mode][k], (p.name, mode, k)
    for bad in ({'modes': {'hosted': {'daily_pair_budget': base['modes']['hosted']['daily_pair_budget'] + 1}}},
                {'modes': {'hosted': {'providers': ['openai']}}}, {'modes': {'admin': {}}}, {'security_headers': {}}, {'max_request_bytes': 10 ** 9}):
        with pytest.raises(ValueError):
            apply_profile(base, bad)


def test_a_disabled_mode_is_unavailable_and_refused(tmp_path, monkeypatch):
    from src.service import app as svc_mod
    base = json.loads((ROOT / 'configs/live-service.yaml').read_text())
    monkeypatch.setattr(svc_mod, 'CFG', svc_mod.apply_profile(base, {'name': 't', 'modes': {'hosted': {'enabled': False}}}))
    svc = svc_mod.Service(data_dir=tmp_path, start_workers=False)
    assert svc.catalog()['modes']['hosted'] == {**svc.catalog()['modes']['hosted'], 'available': False, 'reason': base['disabled_mode_reason']}
    with pytest.raises(Exception) as e:
        svc.submit(svc_mod.RunRequest(mode='hosted', system='gateway_capability', model='nvidia:openai/gpt-oss-20b', cases=['doc-benign']), 'a', 'o')
    assert e.value.status_code == 503
