#!/usr/bin/env bash
# Shared by go-public.sh and funnel-check.sh (R12-05). SOURCED, never run. What is asked of the RUNNING deployment, not of the env file.
# Expects $dc (the compose wrapper) to be set by the caller.

tr_container() { $dc ps -q app 2>/dev/null | head -n1; }

# The single host port Docker really publishes for the app's port 3000, and only if it is bound to loopback. Anything else: no answer.
tr_host_port() {
  local id lines
  id=$(tr_container)
  [ -n "$id" ] || return 1
  lines=$(docker port "$id" 3000/tcp 2>/dev/null) || return 1
  [ "$(printf '%s\n' "$lines" | grep -c .)" = 1 ] || return 1
  case "$lines" in 127.0.0.1:[0-9]*) printf '%s' "${lines##*:}" ;; *) return 1 ;; esac
}

# An environment variable of the running app.
tr_app_env() { $dc exec -T app printenv "$1" 2>/dev/null; }

# The "proxy <url>" targets of a `tailscale funnel status` text, one per line.
# No match is an empty answer, never a failing status (the callers run under `set -e`).
tr_proxy_targets() { { printf '%s\n' "$1" | grep -Eo 'proxy +[^ ]+' | sed -E 's/^proxy +//'; } || true; }
