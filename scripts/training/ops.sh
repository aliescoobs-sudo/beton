#!/usr/bin/env bash
# Runs one maintenance script of the training instance in the ops container with plain node.
#   ./scripts/training/ops.sh db-bootstrap | db-migrate | seed-training | reset-training
# R17-01: the image check (including the refusal of a shell APP_IMAGE, a second env file's APP_IMAGE and extra compose options, and the check of
# the images compose resolves for app AND ops) is made by dc.sh on every call, so the privileged ops container can only run the validated digest.
set -euo pipefail
script="${1:?usage: ops.sh <script name without .ts> [args…]}"
shift
exec "$(dirname "$0")/dc.sh" run --rm -T ops node --import ./scripts/register-ts-paths.mjs "scripts/${script}.ts" "$@"
