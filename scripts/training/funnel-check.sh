#!/usr/bin/env bash
# Fails (exit 1) unless the Tailscale Funnel is what it should be (T1, R11, R12-05): closed, or open with the running training app as
# its ONE target. No Tailscale on this machine, or a Funnel clearly off: 0. Everything else, including a status it cannot read or parse,
# is a failure. Run by training-up.sh. It checks; it never authorises: go-public.sh is the gate.
set -uo pipefail
cd "$(dirname "$0")/../.."
command -v tailscale >/dev/null 2>&1 || exit 0
dc=./scripts/training/dc.sh
. "$(dirname "$0")/lib.sh"
status=$(tailscale funnel status 2>&1)
if [ $? -ne 0 ]; then echo "WARNING: cannot read the Tailscale Funnel status; treating it as unsafe. Close it:  tailscale funnel reset" >&2; exit 1; fi
if ! printf '%s\n' "$status" | grep -qi 'funnel on'; then
  # clearly off ("No serve config", "Funnel off", nothing at all) is fine; a text that mentions neither is not understood
  if [ -z "$(printf '%s' "$status" | tr -d '[:space:]')" ] || printf '%s\n' "$status" | grep -Eqi 'no serve config|funnel off|not (enabled|configured)'; then exit 0; fi
  echo "WARNING: the Funnel status is not understood, treating it as unsafe. Close it:  tailscale funnel reset" >&2
  exit 1
fi
rc=0
fail() { echo "WARNING: $1" >&2; rc=1; }
port=$(tr_host_port || true)
[ -n "$port" ] || fail "the Funnel is up but there is no running app published on exactly one loopback port. Stop the Funnel now:  tailscale funnel reset"
[ "$(tr_app_env TRAINING_MODE || true)" = "true" ] || fail "the Tailscale Funnel is up but the app is not running with TRAINING_MODE=true. Stop the Funnel now:  tailscale funnel reset"
targets=$(tr_proxy_targets "$status")
if [ "$(printf '%s\n' "$targets" | grep -c .)" != 1 ]; then
  fail "the Funnel is up but exactly one HTTP proxy target could not be read from its status ($(printf '%s\n' "$targets" | grep -c .) found). Stop it now:  tailscale funnel reset"
elif [ -n "$port" ] && [ "$targets" != "http://127.0.0.1:$port" ]; then
  fail "the Funnel proxies to $targets, not to this app (http://127.0.0.1:$port, the port Docker really publishes). Something else may be on the internet: tailscale funnel reset"
fi
# R13-04: the COMPLETE configuration, not only the proxy URLs: any other entry (a TCP forward, a second host or path, a tailnet-only
# service...) is a failure, whatever the proxy line says.
if [ "$rc" = 0 ] && [ -n "$port" ]; then
  tr_funnel_exactly_one_proxy "http://127.0.0.1:$port" || fail "the Funnel configuration is not exactly one HTTPS proxy to this app: something else may be served. Stop it now:  tailscale funnel reset"
fi
exit $rc
