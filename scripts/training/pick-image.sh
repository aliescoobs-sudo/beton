#!/usr/bin/env bash
# Prints the image reference (name@sha256:digest) built by the "Build and publish image" workflow FOR THE EXACT COMMIT this checkout is on.
# "The latest green run" can be another commit than the code you are about to run; this ties the image to HEAD, or refuses.
#   APP_IMAGE=$(./scripts/training/pick-image.sh) ./scripts/training/init-env.sh
# Needs the GitHub CLI signed in (gh auth login). Prints only the reference on stdout; the reasons for a refusal go to stderr.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "pick-image.sh: $*" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || fail "the GitHub CLI (gh) is not installed or not signed in"
sha=$(git rev-parse HEAD)
git diff --quiet HEAD -- 2>/dev/null || echo "pick-image.sh: warning: the checkout has uncommitted changes; the image is that of commit $sha only" >&2
git fetch --quiet origin 2>/dev/null || true
if git rev-parse --verify --quiet origin/main >/dev/null && [ "$(git rev-parse origin/main)" != "$sha" ]; then
  echo "pick-image.sh: warning: this checkout ($sha) is not the tip of origin/main; update with 'git pull' if you meant the newest version" >&2
fi
id=$(gh run list --workflow "Build and publish image" --commit "$sha" --status success --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
[ -n "$id" ] && [ "$id" != "null" ] || fail "no green image build for commit $sha: wait for the workflow of this commit to finish green, or check out a commit that has one"
line=$(gh run view "$id" --log 2>/dev/null | grep -o 'IMAGE_REF=[^ ]* COMMIT=[0-9a-f]\{40\}' | head -n1 || true)
[ -n "$line" ] || fail "the run $id has no IMAGE_REF line (a build made before this check existed): run the workflow again for this commit"
ref=${line#IMAGE_REF=}
ref=${ref%% *}
built=${line##*COMMIT=}
[ "$built" = "$sha" ] || fail "the run $id built commit $built, not $sha"
. ./scripts/training/image-policy.sh
kayas_check_image "$ref" pick-image.sh || fail "unexpected image reference"
echo "pick-image.sh: commit $sha  image $ref" >&2
echo "$ref"
