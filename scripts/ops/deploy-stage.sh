#!/usr/bin/env bash
# Phase 1 of a deployment (T10g): runs under the deploy lock, from the CURRENT checkout. It validates, takes the backup with the current release, pulls the
# new image, writes the new approval and moves the checkout to the approved commit, then hands over (exec) to phase 2 from the NEW tree.
set -euo pipefail
umask 027
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
. ./scripts/ops/deploy-lib.sh
kayas_reject_overrides deploy.sh
[ -n "${KAYAS_LOCK_FD:-}" ] || { echo "deploy.sh: not running under the deploy lock (start it with scripts/ops/deploy.sh)" >&2; exit 1; }
mkdir -p release

if [ "${1:-}" = --recover ]; then
  kayas_journal_last
  case "$LAST_STATE" in
    ''|done|rollback_verified|recovered) echo "deploy.sh: nothing to recover (last state: ${LAST_STATE:-none})"; exit 0 ;;
  esac
  echo "deploy.sh: recovering from state '$LAST_STATE'" >&2
  exec bash scripts/ops/deploy-run.sh --recover
fi

commit="${1:?usage: deploy.sh <commit> <image> <platform> <run id> | --recover}" image="${2:?image}" platform="${3:?platform}" run_id="${4:?run id}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy.sh: the commit must be 40 lowercase hex characters" >&2; exit 2; }
kayas_check_image "$image" deploy.sh || exit 2
[ "$platform" = linux/amd64 ] || { echo "deploy.sh: the platform must be linux/amd64" >&2; exit 2; }
[[ "$run_id" =~ ^[0-9]{1,20}$ ]] || { echo "deploy.sh: the run id must be numeric" >&2; exit 2; }

# an earlier deployment that did not finish must be recovered first
kayas_journal_last
case "$LAST_STATE" in
  ''|done|rollback_verified|recovered|refused|failed_before_switch) ;;
  *) echo "deploy.sh: the last deployment did not finish (state '$LAST_STATE', see release/.deploy-journal). Run  ./scripts/ops/deploy.sh --recover  first." >&2; exit 1 ;;
esac

prev_commit="" prev_image="" prev_platform="" prev_run=""
if [ -e release/APPROVED ]; then
  kayas_read_approved deploy.sh
  prev_commit="$RELEASE_COMMIT" prev_image="$RELEASE_IMAGE" prev_platform="$RELEASE_PLATFORM" prev_run="$RELEASE_RUN_ID"
  kayas_require_release_checkout deploy.sh || { kayas_journal refused "the host is not at its own approved release"; exit 1; }
else
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "deploy.sh: tracked files are edited on the host. Refused." >&2; exit 1; }
fi
kayas_reject_env_file_image deploy.sh .env.prod .env.ops.prod .env.backup.prod .env.bootstrap.prod

# the exact commit, from the origin, and only a commit that is part of main
git fetch --no-tags origin >&2
git cat-file -e "$commit^{commit}" 2>/dev/null || { echo "deploy.sh: commit $commit is not in the origin" >&2; kayas_journal refused "unknown commit"; exit 1; }
git merge-base --is-ancestor "$commit" origin/main || { echo "deploy.sh: commit $commit is not part of origin/main. Refused." >&2; kayas_journal refused "commit not on main"; exit 1; }

kayas_journal begin "${prev_commit:-none}:${commit}" "prev=${prev_image##*@} next=${image##*@}"
fail_before_switch() { kayas_journal failed_before_switch "$1"; echo "deploy.sh: $1. Nothing was switched; the running release is unchanged." >&2; exit 1; }
docker pull "$image" >&2 || fail_before_switch "the image could not be pulled"
got_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image" 2>/dev/null || true)"
[ "$got_platform" = "$platform" ] || fail_before_switch "the pulled image is $got_platform, not $platform"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
kayas_journal pulled "id=$image_id"
if [ -n "$prev_commit" ]; then
  ./scripts/ops/backup-nightly.sh >&2 || fail_before_switch "the backup with the current release failed"
  kayas_journal backup_ok ""
fi
# switch: previous approval kept for the rollback, new approval written, checkout moved to the exact commit
[ -z "$prev_commit" ] || cp -f release/APPROVED release/APPROVED.previous
kayas_write_approved "$commit" "$image" "$platform" "$run_id"
git checkout --detach --quiet "$commit"
kayas_journal switched "commit=$commit"
exec bash scripts/ops/deploy-run.sh
