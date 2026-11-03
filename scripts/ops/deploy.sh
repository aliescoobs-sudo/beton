#!/usr/bin/env bash
# Deploys an image BY DIGEST (C2): the digest printed by the "Build and publish image" GitHub Actions workflow, never a moving tag.
#   ./scripts/ops/deploy.sh ghcr.io/<owner>/belgobeton@sha256:<digest>
# Needs `docker login ghcr.io` once on the server with a read-only token (read:packages) of the private registry. Steps: pull, fresh
# backup, migrate with the new image, start it, wait for readiness (which counts the migrations); if it does not become ready the
# previous image is started again. The schema is additive, so the previous image runs on the migrated database.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${1:?usage: deploy.sh ghcr.io/<owner>/belgobeton@sha256:<digest>}"
case "$image" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "deploy.sh: give an image reference with @sha256:<64 hex>" >&2; exit 2;; esac
env_file=.env.ops.prod
previous=$(grep -E '^APP_IMAGE=' "$env_file" | tail -n1 | cut -d= -f2- || true)
docker pull "$image"
./scripts/ops/backup-nightly.sh
set_image() { grep -v '^APP_IMAGE=' "$env_file" > "$env_file.new" || true; echo "APP_IMAGE=$1" >> "$env_file.new"; chmod 600 "$env_file.new"; mv "$env_file.new" "$env_file"; }
set_image "$image"
./scripts/ops/ops.sh db-migrate
./scripts/ops/dc.sh up -d app proxy
ready=no
for _ in $(seq 1 30); do
  if ./scripts/ops/dc.sh exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready 2>/dev/null | grep -q '"ready"'; then ready=yes; break; fi
  sleep 5
done
if [ "$ready" != yes ]; then
  echo "deploy.sh: the new image did not become ready" >&2
  if [ -n "$previous" ]; then set_image "$previous"; ./scripts/ops/dc.sh up -d app; echo "rolled back to $previous" >&2; fi
  exit 1
fi
echo "deployed $image (previous: ${previous:-none})"
