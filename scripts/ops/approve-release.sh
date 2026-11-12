#!/usr/bin/env bash
# Records the APPROVED RELEASE of this host (T10g, R19B-02): commit, image digest, platform, workflow run id. The operator copies the four values from
# the summary of the "Build and publish image" run (it prints them for exactly this) AFTER checking that the run is green for that commit, including its
# integration job (the image job needs it, so a digest exists only if integration passed). This script cannot reach GitHub; it validates the SHAPE,
# that the commit exists in this checkout, and refuses to replace an existing approval unless --replace is given.
#   ./scripts/ops/approve-release.sh <commit 40 hex> ghcr.io/<owner>/kayas@sha256:<digest> linux/amd64 <run id>  [--replace]
set -euo pipefail
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
commit="${1:?usage: approve-release.sh <commit> <image> <platform> <run id> [--replace]}" image="${2:?image}" platform="${3:?platform}" run_id="${4:?run id}"
replace="${5:-}"
kayas_reject_overrides approve-release.sh
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "approve-release.sh: the commit must be 40 lowercase hex characters" >&2; exit 2; }
kayas_check_image "$image" approve-release.sh || exit 2
[ "$platform" = linux/amd64 ] || { echo "approve-release.sh: the platform must be linux/amd64" >&2; exit 2; }
[[ "$run_id" =~ ^[0-9]{1,20}$ ]] || { echo "approve-release.sh: the run id must be numeric" >&2; exit 2; }
git cat-file -e "$commit^{commit}" 2>/dev/null || { echo "approve-release.sh: this checkout does not contain commit $commit (git fetch it first)" >&2; exit 1; }
mkdir -p release
if [ -e release/APPROVED ] && [ "$replace" != --replace ]; then echo "approve-release.sh: release/APPROVED exists; pass --replace to change it (scripts/ops/deploy.sh does this for an upgrade)" >&2; exit 1; fi
[ ! -L release/APPROVED ] || { echo "approve-release.sh: release/APPROVED is a link: refused" >&2; exit 1; }
tmp="$(umask 027; mktemp release/.APPROVED.XXXXXX)"
trap 'rm -f -- "$tmp"' EXIT
{
  echo "# KAYAS approved release. Written by scripts/ops/approve-release.sh; do not edit."
  echo "COMMIT=$commit"
  echo "IMAGE=$image"
  echo "PLATFORM=$platform"
  echo "RUN_ID=$run_id"
} > "$tmp"
chmod 640 "$tmp"
mv -f -- "$tmp" release/APPROVED
trap - EXIT
echo "approve-release.sh: approved ${commit:0:12} / ${image##*@} (run $run_id). The host files must be at that commit: git checkout --detach $commit"
