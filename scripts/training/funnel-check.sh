#!/usr/bin/env bash
# Fails (exit 1) unless the Tailscale Funnel is what it should be (T1, R11, R12-05, R14-07): closed, or open with the running training app
# as its ONE target. No Tailscale on this machine: 0. Everything else, including a status it cannot read, parse or validate, is a failure.
# Both "closed" and "open correctly" are decided on the COMPLETE structured status (`tailscale funnel status --json`, validated by
# python3); the text status is never trusted, and an old CLI without --json is a failure too. Run by training-up.sh, which stops on a
# failure. It checks; it never authorises: go-public.sh is the gate.
set -uo pipefail
cd "$(dirname "$0")/../.."
command -v tailscale >/dev/null 2>&1 || exit 0
dc=./scripts/training/dc.sh
. "$(dirname "$0")/lib.sh"
tr_funnel_read; rc=$?
if [ "$rc" -ne 0 ]; then
  tr_funnel_read_explain "$rc"
  echo "WARNING: cannot inspect the Tailscale Funnel; treating it as unsafe. Close it:  tailscale funnel reset" >&2
  exit 1
fi
if tr_funnel_json_empty "$TR_JSON"; then exit 0; fi # read completely, and nothing is served
rc=0
fail() { echo "WARNING: $1" >&2; rc=1; }
port=$(tr_host_port || true)
[ -n "$port" ] || fail "the Funnel is configured but there is no running app published on exactly one loopback port. Stop the Funnel now:  tailscale funnel reset"
[ "$(tr_app_env TRAINING_MODE || true)" = "true" ] || fail "the Tailscale Funnel is configured but the app is not running with TRAINING_MODE=true. Stop the Funnel now:  tailscale funnel reset"
if [ "$rc" = 0 ] && [ -n "$port" ]; then
  tr_funnel_json_ok "$TR_JSON" "http://127.0.0.1:$port" || fail "the Funnel configuration is not exactly one HTTPS proxy to this app (http://127.0.0.1:$port, the port Docker really publishes): something else may be served. Stop it now:  tailscale funnel reset"
fi
exit $rc
