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

# ---- R13-04: closing and checking the Funnel, fail closed ------------------------------------------------------------------------------

# True only when `tailscale funnel status` was READ and says, in so many words, that nothing is served: empty, or "No serve config" /
# "Funnel off" / "not enabled|configured", and no "Funnel on", no proxy, no handler line, no address. A status that cannot be read, or
# is not understood, is NOT closed.
tr_funnel_closed() {
  local s
  s=$(tailscale funnel status 2>&1) || return 1
  if printf '%s\n' "$s" | grep -Eqi 'funnel on|proxy|path|\|--|tcp://|https?://'; then return 1; fi
  [ -z "$(printf '%s' "$s" | tr -d '[:space:]')" ] && return 0
  printf '%s\n' "$s" | grep -Eqi 'no serve config|funnel off|not (enabled|configured)'
}

# Resets the Funnel and VERIFIES it is closed. Returns 0 only if the reset succeeded AND the status reads back closed.
tr_close_funnel() {
  tailscale funnel reset >/dev/null 2>&1 || return 1
  tr_funnel_closed
}

tr_closure_unconfirmed() { echo "CLOSURE UNCONFIRMED — check Tailscale manually (tailscale funnel status; tailscale funnel reset)." >&2; }

# The COMPLETE configuration must be exactly one HTTPS proxy ("/" -> $2) with the Funnel allowed on it, and nothing else: no TCP forward,
# no other host, port, mount point or path handler. $1 is the JSON of `tailscale funnel status --json`.
tr_funnel_json_ok() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    c = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
want = sys.argv[2]
if not isinstance(c, dict):
    sys.exit(1)
extra = [k for k, v in c.items() if k not in ("TCP", "Web", "AllowFunnel") and v not in (None, {}, [], "", False)]
if extra:
    sys.exit(1)
tcp, web, allow = c.get("TCP") or {}, c.get("Web") or {}, c.get("AllowFunnel") or {}
if len(tcp) != 1 or len(web) != 1 or len(allow) != 1:
    sys.exit(1)
(port, tcpcfg), = tcp.items()
if tcpcfg != {"HTTPS": True}:
    sys.exit(1)
(hostport, site), = web.items()
if not hostport.endswith(":" + port) or set(site) - {"Handlers"}:
    sys.exit(1)
handlers = site.get("Handlers") or {}
if list(handlers) != ["/"] or handlers["/"] != {"Proxy": want}:
    sys.exit(1)
if allow != {hostport: True}:
    sys.exit(1)
PY
}

# The same rule on the plain-text status, line by line: every line must be one this check knows. $1 is the text, $2 the target.
tr_funnel_text_ok() {
  local line proxies=0 headers=0
  while IFS= read -r line; do
    case "$line" in
      "") ;;
      "# Funnel on:") ;;
      "#     - https://"*) ;;
      "|-- / proxy $2") proxies=$((proxies + 1)) ;;
      "https://"*" (Funnel on)")
        case "${line%% *}" in *[!A-Za-z0-9./:_-]*) return 1 ;; esac
        headers=$((headers + 1)) ;;
      *) return 1 ;;
    esac
  done <<TEXT
$1
TEXT
  [ "$proxies" = 1 ] && [ "$headers" = 1 ]
}

# Reads the whole status of the Funnel and accepts only "one HTTPS proxy to $1". Uses the structured status when the CLI offers it and
# python3 can read it; otherwise the text, line by line. An unreadable status is a refusal.
tr_funnel_exactly_one_proxy() {
  local json text
  if json=$(tailscale funnel status --json 2>/dev/null) && [ -n "$(printf '%s' "$json" | tr -d '[:space:]')" ]; then
    tr_funnel_json_ok "$json" "$1" && return 0
    command -v python3 >/dev/null 2>&1 && return 1 # the structured status was read and it is not exactly that: refused
  fi
  text=$(tailscale funnel status 2>&1) || return 1
  tr_funnel_text_ok "$text" "$1"
}
