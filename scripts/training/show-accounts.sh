#!/usr/bin/env bash
# Prints the training credentials file (written once by seed:training with mode 0600 by the container user). Read it, hand the lines out
# in person, keep nothing on the screen. A reset writes new ones.
set -euo pipefail
exec "$(dirname "$0")/dc.sh" run --rm -T ops cat /app/out/training-accounts.local.txt
