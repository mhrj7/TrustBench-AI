"""TB-053: the release package is built from the tagged commit, scanned for keys, and its quickstart matches the README."""
import json, runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NS = runpy.run_path(str(ROOT / 'scripts/release-package.py'), run_name='pkg')


def test_the_assets_are_the_report_claims_manifest_license_notices_checks_and_source():
    names = NS['asset_names']('v1.0.0')
    assert set(names) == {'trustbench-1.0.0-source.tar.gz', 'trustbench-1.0.0-report.md', 'trustbench-1.0.0-claims.md',
                          'trustbench-1.0.0-reproduction-manifest.json', 'trustbench-1.0.0-LICENSE',
                          'trustbench-1.0.0-THIRD_PARTY_NOTICES.md', 'trustbench-1.0.0-release-checks.json'}
    for src in filter(None, names.values()):
        assert src == 'release/checks.json' or (ROOT / src).exists(), src  # the check record is written after the candidate commit


def test_the_scan_catches_keys_excluded_paths_and_personal_paths():
    scan = NS['scan']
    assert scan({'TrustBench-AI-1.0.0/README.md': b'nothing here'}) == []
    assert scan({'TrustBench-AI-1.0.0/a.txt': b'key nvapi-' + b'A' * 30})
    assert scan({'TrustBench-AI-1.0.0/.env': b'x'}), 'a .env file must never be packaged'
    assert scan({'TrustBench-AI-1.0.0/deploy/secrets/nvidia_api_key': b'x'})
    assert scan({'TrustBench-AI-1.0.0/b.md': b'see /Users/someone/file'})


def test_the_quickstart_is_the_readme_install_and_checks_from_an_archive():
    cmds = NS['quickstart_commands']('1.0.0', 'https://example.invalid/x.tar.gz')
    readme = (ROOT / 'README.md').read_text()
    for c in cmds[2:]:
        assert c in readme, f'quickstart step not in the README: {c}'
    assert cmds[0].startswith('curl -fsSL https://example.invalid/x.tar.gz | tar -xz') and cmds[1] == 'cd TrustBench-AI-1.0.0'


def test_the_project_is_mit_licensed_and_notices_cover_agentdojo():
    assert (ROOT / 'LICENSE').read_text().startswith('MIT License')
    assert json.loads((ROOT / 'package.json').read_text())['license'] == 'MIT'
    notices = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text()
    assert 'AgentDojo' in notices and 'third_party/licenses/AgentDojo-MIT.txt' in notices and 'not included' in notices
