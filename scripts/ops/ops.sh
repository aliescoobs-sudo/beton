#!/usr/bin/env bash
# Runs one maintenance script in the ops container with plain node: no pnpm, no corepack, no network (the ops container is on an
# internal network and cannot download anything; CODEX-REVIEW-R9 item 10).
#   ./scripts/ops/ops.sh db-migrate
#   ./scripts/ops/ops.sh import-excel clients imports/clients.xlsx --apply
set -euo pipefail
script="${1:?usage: ops.sh <script name without .ts> [args…]}"
shift
exec "$(dirname "$0")/dc.sh" run --rm -T ops node --import ./scripts/register-ts-paths.mjs "scripts/${script}.ts" "$@"
