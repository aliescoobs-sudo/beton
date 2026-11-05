#!/usr/bin/env bash
# Starts the training instance (T1) on this machine, and prepares it on the first run: image, database, roles, structure, training data.
# Safe to run again (an already seeded database is left alone). Prints what to do next by hand.
#   ./scripts/training-up.sh
set -euo pipefail
cd "$(dirname "$0")/.."
dc=./scripts/training/dc.sh
ops=./scripts/training/ops.sh
for f in .env.training .env.training.ops; do
  [ -r "$f" ] || { echo "training-up.sh: $f is missing. First run:  APP_IMAGE=ghcr.io/<owner>/belgobeton@sha256:<digest> ./scripts/training/init-env.sh" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "training-up.sh: Docker does not answer. On the iMac start it first:  colima start --arch x86_64 --cpu 2 --memory 4 --disk 40" >&2; exit 1; }
$dc pull
# R11-04: the credentials file lives in a Docker volume ("accounts"), not in a folder of this checkout that other users of the machine could
# reach: the folder is made owned by the container user (10001) and closed to everybody else (0700) before the seed writes into it.
$dc run --rm -T --user root ops sh -c 'mkdir -p /app/out && chown 10001:10001 /app/out && chmod 700 /app/out'
$dc up -d --wait db
$ops db-bootstrap
$ops db-migrate
$ops seed-training
$dc up -d app
./scripts/training/funnel-check.sh || true
cat <<'NEXT'

The training instance is running on this machine only:  http://127.0.0.1:3000

Next, by hand:
  1. Read the accounts ONCE (never paste them in a chat or commit them):   ./scripts/training/show-accounts.sh
  2. Make it reachable from outside with Tailscale Funnel (docs/checkpoints/CP-TRAINING.md, step 8):
        tailscale funnel --bg 3000
     then give the app its public address:                                   ./scripts/training/set-url.sh https://<your-machine>.<tailnet>.ts.net
  3. Stop everything with  ./scripts/training-down.sh   (and  tailscale funnel reset  to close the public address).
NEXT
