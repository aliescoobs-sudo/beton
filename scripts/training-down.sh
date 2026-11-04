#!/usr/bin/env bash
# Stops the training instance (the data stay in the Docker volumes). The Funnel is NOT touched here: close it yourself with
# `tailscale funnel reset` (it would answer with an error page anyway once the app is stopped).
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/training/dc.sh --profile public --profile ops stop
cat <<'NEXT'

Stopped. The data are kept. To also close the public address:   tailscale funnel reset
To start again:                                                  ./scripts/training-up.sh
To start from the clean seed (new passwords):                    ./scripts/training-reset.sh
NEXT
