#!/usr/bin/env bash
# Stops the local-network relay and VERIFIES that it is gone (T10g, R19B-11). Run by lan-down.sh and by the ordinary shutdown (training-down.sh): before, the usual
# stop left the host relay listening, and a later service that bound loopback port 8443 would have been reachable from the Wi-Fi through it.
#   - the process of the pid file (only if its command line really is lan-relay.mjs) gets TERM, then KILL after five seconds;
#   - any other process running scripts/training/lan-relay.mjs (a lost pid file) is stopped the same way;
#   - then the check: no such process remains, and, when the LAN address is known, a connection to <LAN address>:8443 is refused.
# Exit 0 only when all of that holds. Exit 1 says what survived. Nothing here touches Docker.
set -uo pipefail
cd "$(dirname "$0")/../.."
pidfile=.training-lan-relay.pid
match='scripts/training/lan-relay.mjs'
pids_of_relay() { pgrep -f "$match" 2>/dev/null | grep -v "^$$\$" || true; }
stop_pid() {
  local pid="$1" i
  case "$(ps -p "$pid" -o command= 2>/dev/null)" in *lan-relay.mjs*) ;; *) return 0 ;; esac
  kill "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null || true
  sleep 0.5
}
if [ -s "$pidfile" ]; then stop_pid "$(cat "$pidfile")"; fi
for pid in $(pids_of_relay); do stop_pid "$pid"; done
: > "$pidfile" 2>/dev/null || true
left="$(pids_of_relay)"
if [ -n "$left" ]; then echo "relay-stop.sh: the relay is STILL RUNNING (pid $left): the LAN door is not closed" >&2; exit 1; fi
ip="$(sed -n 's/^LAN_BIND_IP=//p' .env.training 2>/dev/null | head -n1)"
if [ -n "$ip" ] && [[ "$ip" =~ ^[0-9.]+$ ]]; then
  if (exec 3<>"/dev/tcp/$ip/${LAN_PORT_CHECK:-8443}") 2>/dev/null; then
    echo "relay-stop.sh: something still accepts connections on $ip:${LAN_PORT_CHECK:-8443}: the LAN door is not closed" >&2; exit 1
  fi
fi
echo "relay-stop.sh: the relay is stopped and nothing listens on the LAN address."
