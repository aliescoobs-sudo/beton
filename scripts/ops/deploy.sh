#!/usr/bin/env bash
# Deploys an image BY DIGEST (C2): the digest printed by the "Build and publish image" GitHub Actions workflow, never a moving tag.
#   ./scripts/ops/deploy.sh ghcr.io/<owner>/kayas@sha256:<digest>
# Needs `docker login ghcr.io` once on the server with a read-only token (read:packages) of the private registry. Steps: pull, fresh
# backup, migrate with the new image, start it, wait for readiness (which counts the migrations). ANY failure after the image has been
# switched (migration, start, readiness) puts the previous image back (D5, F05: before, only a readiness timeout did, and the script
# also changed into the wrong directory). The schema is additive, so the previous image runs on the migrated database; a rollback of the
# image is not a rollback of the data (restore, runbook section 5).
# Environment overrides exist for the tests only: DOCKER, DC, OPS, BACKUP, READY_TRIES, READY_SLEEP.
set -euo pipefail
# R11-03: the env file holds the database and encryption secrets: everything created here is private from its first byte.
umask 077
cd "$(dirname "$0")/../.."
image="${1:?usage: deploy.sh ghcr.io/<owner>/kayas@sha256:<digest>}"
case "$image" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "deploy.sh: give an image reference with @sha256:<64 hex>" >&2; exit 2;; esac
env_file=.env.ops.prod
[ -r "$env_file" ] || { echo "deploy.sh: $env_file not found in $(pwd)" >&2; exit 1; }
[ ! -L "$env_file" ] || { echo "deploy.sh: $env_file is a symbolic link: refusing" >&2; exit 1; }
docker_bin="${DOCKER:-docker}"
dc="${DC:-./scripts/ops/dc.sh}"
ops="${OPS:-./scripts/ops/ops.sh}"
backup="${BACKUP:-./scripts/ops/backup-nightly.sh}"
tries="${READY_TRIES:-30}"
nap="${READY_SLEEP:-5}"
previous=$(grep -E '^APP_IMAGE=' "$env_file" | tail -n1 | cut -d= -f2- || true)
# mktemp creates its file exclusively with mode 0600 (a pre-existing or symlinked name is never reused); the rename is atomic.
set_image() {
  local tmp
  tmp=$(mktemp "$env_file.XXXXXX") || return 1
  if { grep -v '^APP_IMAGE=' "$env_file" || true; echo "APP_IMAGE=$1"; } > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$env_file"; then return 0; fi
  rm -f "$tmp"
  return 1
}

# Nothing has changed yet: a failure here leaves the running image alone.
"$docker_bin" pull "$image"
"$backup"

switched=no
rollback() {
  code=$?
  trap - EXIT
  if [ "$switched" = yes ] && [ "$code" -ne 0 ]; then
    echo "deploy.sh: failed after switching to $image (exit $code)" >&2
    if [ -n "$previous" ]; then
      set_image "$previous"
      "$dc" up -d app || echo "deploy.sh: ROLLBACK START FAILED: start $previous by hand" >&2
      echo "rolled back to $previous" >&2
    else
      echo "deploy.sh: there was no previous image to go back to" >&2
    fi
  fi
  exit "$code"
}
trap rollback EXIT
set_image "$image"
switched=yes
"$ops" db-migrate
"$dc" up -d app proxy
ready=no
for _ in $(seq 1 "$tries"); do
  if "$dc" exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready 2>/dev/null | grep -q '"ready"'; then ready=yes; break; fi
  sleep "$nap"
done
if [ "$ready" != yes ]; then
  echo "deploy.sh: the new image did not become ready" >&2
  exit 1
fi
switched=no
echo "deployed $image (previous: ${previous:-none})"
