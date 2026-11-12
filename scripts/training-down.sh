#!/usr/bin/env bash
# Stops the training instance (the data stay in the Docker volumes). Local only (R15A-06): there is no public address to close.
set -euo pipefail
cd "$(dirname "$0")/.."
# R19B-11: the host relay of the local-network door is not a container: stop it, and verify that it is gone, before anything else
./scripts/training/relay-stop.sh || { echo "training-down.sh: the local-network relay could not be stopped and verified; the instance was NOT reported stopped" >&2; exit 1; }
./scripts/training/dc.sh stop-all
cat <<'NEXT'

Stopped. The data are kept.
To start again:                                                  ./scripts/training-up.sh
To start from the clean seed (new passwords):                    ./scripts/training-reset.sh
NEXT
