#!/bin/sh
# Install (or refresh) the TB-041 demo watchdog as a per-user LaunchAgent, with deploy/watchdog.sh embedded in it.
# Uninstall: launchctl bootout gui/$(id -u)/ai.trustbench.demo-watchdog && rm ~/Library/LaunchAgents/ai.trustbench.demo-watchdog.plist
set -eu
here=$(cd "$(dirname "$0")" && pwd)
plist="$HOME/Library/LaunchAgents/ai.trustbench.demo-watchdog.plist"
python3 - "$here/watchdog.sh" "$plist" <<'PY'
import plistlib, sys
script = open(sys.argv[1]).read()
plistlib.dump({'Label': 'ai.trustbench.demo-watchdog', 'ProgramArguments': ['/bin/sh', '-c', script], 'RunAtLoad': True,
               'StartInterval': 300, 'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null'}, open(sys.argv[2], 'wb'))
PY
launchctl bootout "gui/$(id -u)/ai.trustbench.demo-watchdog" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "watchdog installed: $plist"
