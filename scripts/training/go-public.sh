#!/usr/bin/env bash
# The ONLY step that opens the training instance to the internet (R11): it refuses unless the app is ready for it. In order:
#   1. the public address given is the one the app was told (APP_BASE_URL in .env.training, set with set-url.sh),
#   2. the app answers its readiness check (database reachable, migrations applied) and runs with TRAINING_MODE=true,
#   3. only then:  tailscale funnel --bg <the app's real port>
# Then test from a phone on mobile data: sign in, write something, sign out.
#   ./scripts/training/go-public.sh https://<machine>.<tailnet>.ts.net
set -euo pipefail
cd "$(dirname "$0")/../.."
url="${1:?usage: go-public.sh https://<public address>}"
url="${url%/}"
case "$url" in https://?*) ;; *) echo "go-public.sh: give the full https:// address" >&2; exit 2;; esac
[ -r .env.training ] || { echo "go-public.sh: .env.training not found: run init-env.sh first" >&2; exit 1; }
known=$(grep -E '^APP_BASE_URL=' .env.training | tail -n1 | cut -d= -f2- | tr -d '"' || true)
if [ "$known" != "$url" ]; then
  echo "go-public.sh: the app was told \"${known:-nothing}\" as its address, not $url. First:  ./scripts/training/set-url.sh $url" >&2
  exit 1
fi
port=$(grep -E '^APP_PORT=' .env.training | tail -n1 | cut -d= -f2- | tr -d '"' || true)
port="${port:-3000}"
dc=./scripts/training/dc.sh
mode=$($dc exec -T app printenv TRAINING_MODE 2>/dev/null || true)
[ "$mode" = "true" ] || { echo "go-public.sh: the app is not running in training mode (or not running): start it with ./scripts/training-up.sh" >&2; exit 1; }
ready=no
for _ in $(seq 1 "${READY_TRIES:-12}"); do
  if $dc exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready 2>/dev/null | grep -q '"ready"'; then ready=yes; break; fi
  sleep "${READY_SLEEP:-5}"
done
[ "$ready" = yes ] || { echo "go-public.sh: the app is not ready (readiness check failed): not opening it to the internet" >&2; exit 1; }
command -v tailscale >/dev/null 2>&1 || { echo "go-public.sh: tailscale is not installed" >&2; exit 1; }
tailscale funnel --bg "$port"
echo "go-public.sh: the Funnel now sends $url to this app (port $port). Test from a phone on mobile data; close it with:  tailscale funnel reset"
