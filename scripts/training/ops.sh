#!/usr/bin/env bash
# Runs one maintenance script of the training instance in the ops container with plain node.
#   ./scripts/training/ops.sh db-bootstrap | db-migrate | seed-training | reset-training
set -euo pipefail
script="${1:?usage: ops.sh <script name without .ts> [args…]}"
shift
# R16-03: dc.sh refuses an image that is not the accepted digest; the check is also made here, before any maintenance script is started.
. "$(dirname "$0")/image-policy.sh"
kayas_check_image "$(sed -n 's/^APP_IMAGE=//p' "$(dirname "$0")/../../.env.training" | head -n1)" "training ops.sh" || exit 1
exec "$(dirname "$0")/dc.sh" run --rm -T ops node --import ./scripts/register-ts-paths.mjs "scripts/${script}.ts" "$@"
