#!/bin/sh
# TB-041 watchdog for the self-hosted demo. deploy/install-watchdog.sh embeds this script in a per-user LaunchAgent that runs
# it every 5 minutes. It must not read the project drive: macOS does not let background jobs read external volumes without
# a privacy grant, so everything here is self-contained and logs go to the system log (`log show --predicate
# 'eventMessage CONTAINS "trustbench-watchdog"'`). It covers what Docker's own restart policy does not: Docker Desktop not
# running, the demo container stopped, or the Funnel publication lost. A container that was removed on purpose stays removed.
# Public DNS (TB-050): on 2026-10-17 Tailscale withdrew the Funnel name's public DNS record while Funnel still showed as on,
# so outside visitors could not resolve the site for hours. The watchdog now resolves the name through a public resolver;
# after 2 misses in a row (10 minutes) it resets and re-publishes Funnel, after 5 (25 minutes), and every 6 misses after
# that, it reconnects Tailscale with the machine's own settings. Misses are counted in a small file under /tmp.
# TRUSTBENCH_WATCHDOG_DRY=1 logs the actions without taking them; TRUSTBENCH_WATCHDOG_DNS_NAME overrides the name and
# TRUSTBENCH_WATCHDOG_ECHO=1 also prints the log lines (tests).
PORT=8088
DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
log() { /usr/bin/logger -t trustbench-watchdog "$1"; [ "${TRUSTBENCH_WATCHDOG_ECHO:-}" = 1 ] && echo "watchdog: $1"; return 0; }
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
act() { if [ "${TRUSTBENCH_WATCHDOG_DRY:-}" = 1 ]; then log "dry run: would $1"; else eval "$2"; fi; }
name=${TRUSTBENCH_WATCHDOG_DNS_NAME:-$("$TS" status --json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null)}
count_file=/tmp/trustbench-watchdog-dns-misses
if [ -n "$state" ] && [ -n "$name" ]; then
  if [ -n "$(/usr/bin/dig +short +time=5 +tries=2 A "$name" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$')" ]; then
    misses=$(cat "$count_file" 2>/dev/null || echo 0)
    [ "$misses" -gt 0 ] && log "public DNS for $name answers again after $misses missed checks"
    echo 0 > "$count_file"
  else
    misses=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 )); echo "$misses" > "$count_file"
    log "public DNS has no record for $name (missed $misses checks in a row)"
    if [ "$misses" -eq 2 ]; then
      act "reset and re-publish funnel" '"$TS" funnel reset >/dev/null 2>&1; sleep 3; "$TS" funnel --bg "$PORT" >/dev/null 2>&1 && log "funnel reset and re-published on port $PORT"'
    elif [ "$misses" -ge 5 ] && [ $(( (misses - 5) % 6 )) -eq 0 ]; then
      prefs=$("$TS" debug prefs 2>/dev/null | /usr/bin/python3 -c 'import json,sys; p=json.load(sys.stdin); print("--hostname=%s --accept-routes=%s" % (p.get("Hostname") or "", str(bool(p.get("RouteAll"))).lower()))' 2>/dev/null)
      [ -n "$prefs" ] && act "reconnect tailscale ($prefs)" '"$TS" down >/dev/null 2>&1; sleep 5; "$TS" up $prefs >/dev/null 2>&1 && log "tailscale reconnected ($prefs)" || log "tailscale reconnect FAILED"'
    fi
  fi
fi
