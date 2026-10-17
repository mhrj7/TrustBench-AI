#!/bin/sh
# TB-041 watchdog for the self-hosted demo. deploy/install-watchdog.sh embeds this script in a per-user LaunchAgent that runs
# it every 5 minutes. It must not read the project drive: macOS does not let background jobs read external volumes without
# a privacy grant, so everything here is self-contained and logs go to the system log (`log show --predicate
# 'eventMessage CONTAINS "trustbench-watchdog"'`). It covers what Docker's own restart policy does not: Docker Desktop not
# running, the demo container stopped, or the Funnel publication lost. A container that was removed on purpose stays removed.
PORT=8088
DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
log() { /usr/bin/logger -t trustbench-watchdog "$1"; }
if ! "$DOCKER" info >/dev/null 2>&1; then
  /usr/bin/pgrep -f /Applications/Docker.app/Contents/MacOS/com.docker.backend >/dev/null || { /usr/bin/open -a /Applications/Docker.app; log "Docker Desktop was not running: started it"; }
  exit 0
fi
state=$("$DOCKER" inspect -f '{{.State.Running}}' trustbench-demo-live-1 2>/dev/null)
if [ "$state" = "false" ]; then
  "$DOCKER" start trustbench-demo-live-1 >/dev/null 2>&1 && log "demo container was stopped: started it" || log "demo container was stopped: start FAILED"
fi
if [ -n "$state" ] && ! "$TS" funnel status 2>/dev/null | grep -q "proxy http://127.0.0.1:$PORT"; then
  "$TS" funnel --bg "$PORT" >/dev/null 2>&1 && log "funnel was off: published port $PORT" || log "funnel was off: publish FAILED"
fi
