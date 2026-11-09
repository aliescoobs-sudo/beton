#!/usr/bin/env bash
# The ONE way to run docker compose for the training instance: it passes both env files, so that compose can read the file from any shell.
set -euo pipefail
cd "$(dirname "$0")/../.."
for f in .env.training .env.training.ops; do [ -r "$f" ] || { echo "training dc.sh: $f not found: run ./scripts/training/init-env.sh first" >&2; exit 1; }; done
# R16-03: every compose call (pull, run, up, exec) goes through the same check of the image reference in the env file.
. ./scripts/training/image-policy.sh
kayas_check_image "$(sed -n 's/^APP_IMAGE=//p' .env.training | head -n1)" "training dc.sh" || exit 1
exec docker compose -f docker-compose.training.yml --env-file .env.training --env-file .env.training.ops "$@"
