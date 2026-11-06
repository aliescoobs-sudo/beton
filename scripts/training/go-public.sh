#!/usr/bin/env bash
# The ONLY step that opens the training instance to the internet (R11, R12-05). It fails closed: every doubt is a refusal and leaves the
# Funnel closed. In order:
#   0. any existing Funnel configuration is reset first (a persistent one would survive a failed run or a restart),
#   1. the public address given is the one the app was told, in the env file AND in the running app,
#   2. the port is the one Docker really publishes for the running app (loopback only) and the env file agrees,
#   3. the running app is a training app (TRAINING_MODE=true, APP_ENV=training, not real data, the test escape off),
#   4. the real loopback endpoint on that port answers the training readiness response of the app,
#   5. only then:  tailscale funnel --bg <that port>, and the FULL funnel status must show exactly one HTTP proxy target, that endpoint.
# Then test from a phone on mobile data: sign in, write something, sign out.
#   ./scripts/training/go-public.sh https://<machine>.<tailnet>.ts.net
set -euo pipefail
cd "$(dirname "$0")/../.."
url="${1:?usage: go-public.sh https://<public address>}"
url="${url%/}"
case "$url" in https://?*) ;; *) echo "go-public.sh: give the full https:// address" >&2; exit 2;; esac
command -v tailscale >/dev/null 2>&1 || { echo "go-public.sh: tailscale is not installed" >&2; exit 1; }
dc=./scripts/training/dc.sh
. "$(dirname "$0")/lib.sh"

# 0. closed first, whatever happens next; and closed again on ANY way out that is not a success (an unexpected error included)
tailscale funnel reset >/dev/null 2>&1 || true
trap 'rc=$?; if [ "$rc" -ne 0 ]; then tailscale funnel reset >/dev/null 2>&1 || true; fi' EXIT
refuse() { tailscale funnel reset >/dev/null 2>&1 || true; echo "go-public.sh: $1 The Funnel is closed." >&2; exit 1; }

[ -r .env.training ] || refuse "no .env.training: run init-env.sh first."
envfile() { grep -E "^$1=" .env.training | tail -n1 | cut -d= -f2- | tr -d '"' || true; }

# 1. the address, in the file and in the running app
known=$(envfile APP_BASE_URL)
[ "$known" = "$url" ] || refuse "the env file says the app's address is \"${known:-nothing}\", not $url. First:  ./scripts/training/set-url.sh $url"
running=$(tr_app_env APP_BASE_URL || true)
[ "$running" = "$url" ] || refuse "the RUNNING app was told \"${running:-nothing}\", not $url (it was not restarted after set-url.sh, or it is not running): ./scripts/training-up.sh"

# 2. the real published port
port=$(tr_host_port || true)
[ -n "$port" ] || refuse "cannot find exactly one loopback host port published for the running app (is it running? is it bound to 127.0.0.1?)."
filed=$(envfile APP_PORT); filed="${filed:-3000}"
[ "$filed" = "$port" ] || refuse "the env file says port $filed but the running app is published on $port: recreate it with ./scripts/training-up.sh."

# 3. a training app
[ "$(tr_app_env TRAINING_MODE || true)" = "true" ] || refuse "the running app is not in training mode."
[ "$(tr_app_env APP_ENV || true)" = "training" ] || refuse "the running app's APP_ENV is not training."
[ "$(tr_app_env REAL_DATA || true)" = "false" ] || refuse "the running app is not clearly REAL_DATA=false."
case "$(tr_app_env TRAINING_ALLOW_UNMARKED || true)" in ""|false) ;; *) refuse "the running app has the unmarked-database escape set.";; esac

# 4. the socket the Funnel will forward to, asked directly
ready=no
for _ in $(seq 1 "${READY_TRIES:-12}"); do
  body=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health/ready" 2>/dev/null || true)
  if printf '%s' "$body" | grep -Eq '"status" *: *"ready"' && printf '%s' "$body" | grep -Eq '"mode" *: *"training"'; then ready=yes; break; fi
  sleep "${READY_SLEEP:-5}"
done
[ "$ready" = yes ] || refuse "http://127.0.0.1:$port did not answer the training readiness response."

# 5. open, then read back the whole status
tailscale funnel --bg "$port" || refuse "tailscale refused to open the Funnel."
status=$(tailscale funnel status 2>&1) || refuse "cannot read the Funnel status back."
printf '%s\n' "$status" | grep -qi 'funnel on' || refuse "the Funnel status does not say the Funnel is on; unrecognised status: not trusting it."
targets=$(tr_proxy_targets "$status")
[ "$(printf '%s\n' "$targets" | grep -c .)" = 1 ] || refuse "the Funnel does not have exactly one proxy target."
[ "$targets" = "http://127.0.0.1:$port" ] || refuse "the Funnel proxies to $targets, not to http://127.0.0.1:$port."
echo "go-public.sh: the Funnel now sends $url to this app (http://127.0.0.1:$port). Test from a phone on mobile data; close it with:  tailscale funnel reset"
