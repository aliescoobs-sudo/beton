#!/usr/bin/env bash
# The ONE rule for which image the training instance may run (R16-03). Sourced by init-env.sh, training-up.sh, dc.sh, ops.sh and pick-image.sh.
# The expected owner is this constant, not an environment variable: nothing a shell exports can widen it. To change the publisher, change it here
# in a reviewed commit.
KAYAS_IMAGE_OWNER="aliescoobs-sudo"
KAYAS_IMAGE_PACKAGE="kayas"
# ghcr.io/<owner>/kayas@sha256:<64 lowercase hex>: no tag, no other registry, no other owner, no other package.
KAYAS_IMAGE_PATTERN="^ghcr\\.io/${KAYAS_IMAGE_OWNER}/${KAYAS_IMAGE_PACKAGE}@sha256:[0-9a-f]{64}\$"

# kayas_check_image <ref> <who>: returns 0 for an accepted reference; otherwise prints why on stderr and returns 1. Prints nothing on success.
kayas_check_image() {
  local ref="${1-}" who="${2:-image-policy}"
  if [ -z "$ref" ]; then echo "$who: APP_IMAGE is empty" >&2; return 1; fi
  if [[ "$ref" =~ $KAYAS_IMAGE_PATTERN ]]; then return 0; fi
  echo "$who: refused image reference. Expected ghcr.io/${KAYAS_IMAGE_OWNER}/${KAYAS_IMAGE_PACKAGE}@sha256:<64 lowercase hex> (no tag, no other owner or package, no uppercase)." >&2
  return 1
}

# kayas_require_image <ref> <who>: exits the calling script when the reference is refused; otherwise prints the accepted digest on stderr.
kayas_require_image() {
  kayas_check_image "$@" || exit 1
  echo "${2:-image-policy}: image accepted, digest ${1##*@}" >&2
}
