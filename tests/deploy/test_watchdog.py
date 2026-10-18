"""TB-041/TB-050: the demo watchdog is self-contained and repairs a lost public DNS record for the Funnel name."""
import os, shutil, subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'deploy/watchdog.sh'
TS = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
DOCKER = '/Applications/Docker.app/Contents/Resources/bin/docker'


def test_the_watchdog_never_reads_the_project_drive_and_checks_public_dns():
    text = SCRIPT.read_text()
    assert '/Volumes/' not in text, 'a LaunchAgent cannot read external volumes without a privacy grant'
    assert '@1.1.1.1' in text and 'funnel reset' in text and '"$TS" up $prefs' in text
    assert subprocess.run(['sh', '-n', str(SCRIPT)]).returncode == 0


@pytest.mark.skipif(not (Path(TS).exists() and Path(DOCKER).exists() and shutil.which('dig')), reason='needs the demo host (Tailscale and Docker Desktop)')
def test_a_missing_record_escalates_from_funnel_reset_to_reconnect_in_a_dry_run(tmp_path):
    counter = Path('/tmp/trustbench-watchdog-dns-misses')
    saved = counter.read_text() if counter.exists() else None
    env = dict(os.environ, TRUSTBENCH_WATCHDOG_DRY='1', TRUSTBENCH_WATCHDOG_ECHO='1', TRUSTBENCH_WATCHDOG_DNS_NAME='nonexistent-probe.invalid')
    try:
        counter.write_text('0')
        out = [subprocess.run(['sh', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120).stdout for _ in range(11)]
        if 'demo container' in ''.join(out) or not any('missed 1 checks' in o for o in out):
            pytest.skip('the demo container is not running on this host')
        assert 'would reset and re-publish funnel' in out[1]
        assert 'would reconnect tailscale' in out[4] and 'would reconnect tailscale' in out[10]
        assert not any('would' in o for i, o in enumerate(out) if i not in (1, 4, 10))
    finally:
        counter.write_text(saved) if saved is not None else counter.unlink(missing_ok=True)
