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

# ---- R14-07: the Funnel is inspected through the COMPLETE structured status, and nothing else ------------------------------------------
# The plain-text status cannot prove the absence of a foreground or service configuration (it does not list them), so it is NEVER used
# to authorise publication or to claim "closed". `tailscale funnel status --json` must succeed and be validated by python3. A CLI that
# does not know --json (too old) and a daemon/control error are BOTH refusals, told apart so the operator knows what to fix.
#   tr_funnel_read   : sets TR_JSON to the structured status; returns 0, or
#                        2 python3 is missing        3 this Tailscale CLI does not support --json (upgrade it)
#                        4 the daemon or control socket failed or said nothing    5 the answer is not JSON
tr_funnel_read() {
  TR_JSON=
  command -v python3 >/dev/null 2>&1 || return 2
  local out err rc errfile
  errfile=$(mktemp) || return 4
  out=$(tailscale funnel status --json 2>"$errfile"); rc=$?
  err=$(cat "$errfile"); rm -f "$errfile"
  if [ "$rc" -ne 0 ]; then
    if printf '%s\n%s\n' "$err" "$out" | grep -Eqi 'flag provided but not defined|unknown flag|unknown shorthand|unrecognized (option|flag|argument)|invalid (flag|option)|unknown option'; then return 3; fi
    return 4
  fi
  [ -n "$(printf '%s' "$out" | tr -d '[:space:]')" ] || return 4
  python3 -c 'import json,sys; json.loads(sys.argv[1])' "$out" >/dev/null 2>&1 || return 5
  TR_JSON=$out
}

# Says, on stderr, why the structured status could not be used. $1 is the return code of tr_funnel_read.
tr_funnel_read_explain() {
  case "$1" in
    2) echo "python3 is required to inspect the Tailscale configuration and is not available: refusing (nothing is assumed closed or safe)." >&2 ;;
    3) echo "this Tailscale CLI does not support 'funnel status --json' (too old): upgrade Tailscale. The text status is NOT accepted instead: refusing." >&2 ;;
    4) echo "the Tailscale daemon or control socket failed to answer 'funnel status --json': refusing (this is not an unsupported CLI)." >&2 ;;
    5) echo "'funnel status --json' did not return valid JSON: refusing." >&2 ;;
  esac
}

# 0 only when the structured status was READ and is COMPLETELY empty: nothing served, no TCP forward, no foreground, no service. Any
# non-empty value of any key, or a non-object, is not closed.
tr_funnel_json_empty() {
  python3 - "$1" <<'PY'
import json, sys
try:
    c = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
if not isinstance(c, dict):
    sys.exit(1)
sys.exit(0 if all(v in (None, {}, [], "", False) for v in c.values()) else 1)
PY
}

# True only when the structured status was read AND is empty. An unreadable or unvalidated status is NOT closed.
tr_funnel_closed() {
  tr_funnel_read; local rc=$?
  if [ "$rc" -ne 0 ]; then tr_funnel_read_explain "$rc"; return 1; fi
  tr_funnel_json_empty "$TR_JSON"
}

# Resets the Funnel and VERIFIES it is closed. Returns 0 only if the reset succeeded AND the structured status reads back empty.
tr_close_funnel() {
  tailscale funnel reset >/dev/null 2>&1 || return 1
  tr_funnel_closed
}

tr_closure_unconfirmed() { echo "CLOSURE UNCONFIRMED — check Tailscale manually (tailscale funnel status --json; tailscale funnel reset)." >&2; }

# The COMPLETE configuration must be exactly one HTTPS proxy ("/" -> $2) with the Funnel allowed on it, and nothing else: no TCP forward,
# no other host, port, mount point or path handler, no foreground, no service. $1 is the JSON of `tailscale funnel status --json`.
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

# Reads the whole structured status and accepts only "one HTTPS proxy to $1". Any failure to read or validate it is a refusal (the reason
# is on stderr); the text status is never a fallback.
tr_funnel_exactly_one_proxy() {
  tr_funnel_read; local rc=$?
  if [ "$rc" -ne 0 ]; then tr_funnel_read_explain "$rc"; return 1; fi
  tr_funnel_json_ok "$TR_JSON" "$1"
}
