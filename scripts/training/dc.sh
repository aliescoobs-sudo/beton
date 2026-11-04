#!/usr/bin/env bash
# The ONE way to run docker compose for the training instance: it passes both env files, so that compose can read the file from any shell.
set -euo pipefail
cd "$(dirname "$0")/../.."
for f in .env.training .env.training.ops; do [ -r "$f" ] || { echo "training dc.sh: $f not found: run ./scripts/training/init-env.sh first" >&2; exit 1; }; done
exec docker compose -f docker-compose.training.yml --env-file .env.training --env-file .env.training.ops "$@"
