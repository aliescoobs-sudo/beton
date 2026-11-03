#!/usr/bin/env bash
# The ONE way to run docker compose on the server (C2, CODEX-REVIEW-R9 item 4). Compose needs the variables of .env.ops.prod
# (POSTGRES_SUPERUSER_PASSWORD, APP_DOMAIN, APP_IMAGE, FIRST_BOOT) to read the file at all, and a plain `docker compose …` in a clean
# shell (a cron job, an SSH session) does not have them. Every runbook command and every cron line goes through this wrapper.
#   ./scripts/ops/dc.sh up -d --wait db
#   ./scripts/ops/dc.sh run --rm ops node --import ./scripts/register-ts-paths.mjs scripts/db-migrate.ts
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -r .env.ops.prod ] || { echo "dc.sh: .env.ops.prod not found or not readable in $(pwd)" >&2; exit 1; }
exec docker compose -f docker-compose.prod.yml --env-file .env.ops.prod "$@"
