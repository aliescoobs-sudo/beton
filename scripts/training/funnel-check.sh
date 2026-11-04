#!/usr/bin/env bash
# Warns when the Tailscale Funnel is up while the running app is NOT in training mode (T1): that would put a non-training server on the
# internet. Exit 1 on the warning, 0 when all is well or when there is no Funnel / no Tailscale on this machine. Run by training-up.sh.
set -uo pipefail
cd "$(dirname "$0")/../.."
command -v tailscale >/dev/null 2>&1 || exit 0
status=$(tailscale funnel status 2>/dev/null || true)
echo "$status" | grep -qi 'funnel on' || exit 0
mode=$(./scripts/training/dc.sh exec -T app printenv TRAINING_MODE 2>/dev/null || true)
if [ "$mode" != "true" ]; then
  echo "WARNING: the Tailscale Funnel is up but the app is not running with TRAINING_MODE=true. Stop the Funnel now:  tailscale funnel reset" >&2
  exit 1
fi
exit 0
