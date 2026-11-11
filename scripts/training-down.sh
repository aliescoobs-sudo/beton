#!/usr/bin/env bash
# Stops the training instance (the data stay in the Docker volumes). Local only (R15A-06): there is no public address to close.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/training/dc.sh stop-all
cat <<'NEXT'

Stopped. The data are kept.
To start again:                                                  ./scripts/training-up.sh
To start from the clean seed (new passwords):                    ./scripts/training-reset.sh
NEXT
