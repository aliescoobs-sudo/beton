#!/usr/bin/env bash
# Runs one maintenance script of the training instance in the ops container with plain node.
#   ./scripts/training/ops.sh db-bootstrap | db-migrate | seed-training | reset-training
set -euo pipefail
script="${1:?usage: ops.sh <script name without .ts> [args…]}"
shift
exec "$(dirname "$0")/dc.sh" run --rm -T ops node --import ./scripts/register-ts-paths.mjs "scripts/${script}.ts" "$@"
