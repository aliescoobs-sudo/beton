#!/usr/bin/env bash
# Warns when the Tailscale Funnel is not what it should be (T1, R11): (1) up while the running app is NOT in training mode, or (2) pointing at
# something else than this app's own port (APP_PORT, 3000 by default). Exit 1 on a warning, 0 when all is well or when there is no Funnel / no
# Tailscale on this machine. Run by training-up.sh. It is a warning and NOT an authorisation to go public: go-public.sh is the gate.
set -uo pipefail
cd "$(dirname "$0")/../.."
command -v tailscale >/dev/null 2>&1 || exit 0
status=$(tailscale funnel status 2>/dev/null || true)
echo "$status" | grep -qi 'funnel on' || exit 0
port=3000
if [ -r .env.training ]; then
  p=$(grep -E '^APP_PORT=' .env.training | tail -n1 | cut -d= -f2- | tr -d '"' || true)
  [ -n "$p" ] && port="$p"
fi
rc=0
mode=$(./scripts/training/dc.sh exec -T app printenv TRAINING_MODE 2>/dev/null || true)
if [ "$mode" != "true" ]; then
  echo "WARNING: the Tailscale Funnel is up but the app is not running with TRAINING_MODE=true. Stop the Funnel now:  tailscale funnel reset" >&2
  rc=1
fi
# Every target the Funnel proxies to must be this app's own port on this machine.
targets=$(echo "$status" | grep -Eo 'proxy +https?://[^ ]+' | sed -E 's/^proxy +//' || true)
for t in $targets; do
  hostport=${t#*://}
  hostport=${hostport%%/*}
  host=${hostport%%:*}
  tport=${hostport##*:}
  [ "$tport" = "$hostport" ] && tport=80
  case "$host" in 127.0.0.1|localhost|::1) ;; *) echo "WARNING: the Funnel proxies to $t, which is not this machine. Stop it now:  tailscale funnel reset" >&2; rc=1; continue;; esac
  if [ "$tport" != "$port" ]; then
    echo "WARNING: the Funnel proxies to $t but the training app listens on port $port. Something else is on the internet: tailscale funnel reset, then  tailscale funnel --bg $port" >&2
    rc=1
  fi
done
exit $rc
