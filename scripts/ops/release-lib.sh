#!/usr/bin/env bash
# Shared rules for binding every privileged action to the APPROVED RELEASE (T10g, R19B-02). Sourced by dc.sh, deploy.sh, ops.sh, bootstrap.sh,
# backup-nightly.sh and the staging wrappers. It defines functions only; it runs nothing.
#
# The approved release is release/APPROVED (written by scripts/ops/approve-release.sh or by a successful deploy; mode 0640; never edited by hand):
#     COMMIT=<40 lowercase hex>        the reviewed commit the host files must be at
#     IMAGE=ghcr.io/<owner>/kayas@sha256:<64 hex>      the image built from that commit by the "Build and publish image" workflow
#     PLATFORM=linux/amd64             the platform that image must have
#     RUN_ID=<digits>                  the GitHub Actions run that built it (its integration job passed: the image job needs it)
# The image is NOT in any .env file and is never taken from the shell: it is passed to compose explicitly from this file, and compose's resolved
# configuration is checked against it (scripts/ops/validate-compose.py) before a container is created.
KAYAS_IMAGE_OWNER="aliescoobs-sudo"
KAYAS_IMAGE_PACKAGE="kayas"
KAYAS_IMAGE_PATTERN="^ghcr\\.io/${KAYAS_IMAGE_OWNER}/${KAYAS_IMAGE_PACKAGE}@sha256:[0-9a-f]{64}\$"

kayas_die() { echo "$1" >&2; return 1; }

# kayas_check_image <ref> <who>: digest only (no tag), the one registry/owner/package, lowercase hex.
kayas_check_image() {
  local ref="${1-}" who="${2:-release}"
  [ -n "$ref" ] || { echo "$who: the image reference is empty" >&2; return 1; }
  [[ "$ref" =~ $KAYAS_IMAGE_PATTERN ]] && return 0
  echo "$who: refused image reference. Expected ghcr.io/${KAYAS_IMAGE_OWNER}/${KAYAS_IMAGE_PACKAGE}@sha256:<64 lowercase hex> (no tag, no other registry, owner or package)." >&2
  return 1
}

# kayas_reject_overrides <who>: nothing a shell exports may change what runs. Refuses (it does not silently scrub) so that the operator learns of it.
kayas_reject_overrides() {
  local who="${1:-release}" v
  for v in APP_IMAGE DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG_OVERRIDE DOCKER_DEFAULT_PLATFORM KAYAS_APPROVED_FILE; do
    if [ -n "${!v+x}" ]; then echo "$who: $v is set in the shell. Refused: the image and the docker endpoint come from the approved release and the host only." >&2; return 1; fi
  done
  while IFS='=' read -r v _; do
    case "$v" in COMPOSE_*) echo "$who: $v is set in the shell. Refused: the compose configuration is fixed by the wrapper." >&2; return 1 ;; esac
  done < <(env)
  return 0
}

# kayas_reject_env_file_image <who> <file>...: an APP_IMAGE (or a second compose image variable) in any env file would compete with the approved one.
kayas_reject_env_file_image() {
  local who="$1" f; shift
  for f in "$@"; do
    [ -e "$f" ] || continue
    [ ! -L "$f" ] || { echo "$who: $f is a symbolic link: refused" >&2; return 1; }
    if grep -q -E '^[[:space:]]*(export[[:space:]]+)?(APP_IMAGE|COMPOSE_[A-Z_]+)[[:space:]]*=' "$f"; then
      echo "$who: $f sets APP_IMAGE or a COMPOSE_* variable. Refused: the image comes from release/APPROVED only (remove the line)." >&2; return 1
    fi
  done
}

# kayas_read_approved <who> [file]: parses the file STRICTLY (no sourcing, no eval) into RELEASE_COMMIT / RELEASE_IMAGE / RELEASE_PLATFORM / RELEASE_RUN_ID.
kayas_read_approved() {
  local who="$1" file="${2:-release/APPROVED}" line key val seen=" "
  [ -f "$file" ] && [ ! -L "$file" ] || { echo "$who: $file is missing (or a link). Approve a release first: scripts/ops/approve-release.sh <commit> <image> <platform> <run id>" >&2; return 1; }
  RELEASE_COMMIT="" RELEASE_IMAGE="" RELEASE_PLATFORM="" RELEASE_RUN_ID=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" =~ ^([A-Z_]+)=([^[:space:]]+)$ ]] || { echo "$who: $file has a line that is not KEY=value" >&2; return 1; }
    key="${BASH_REMATCH[1]}" val="${BASH_REMATCH[2]}"
    case "$seen" in *" $key "*) echo "$who: $file repeats $key" >&2; return 1 ;; esac
    seen+="$key "
    case "$key" in
      COMMIT) RELEASE_COMMIT="$val" ;; IMAGE) RELEASE_IMAGE="$val" ;; PLATFORM) RELEASE_PLATFORM="$val" ;; RUN_ID) RELEASE_RUN_ID="$val" ;;
      *) echo "$who: $file has an unknown key $key" >&2; return 1 ;;
    esac
  done < "$file"
  [[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "$who: COMMIT in $file must be 40 lowercase hex characters" >&2; return 1; }
  kayas_check_image "$RELEASE_IMAGE" "$who" || return 1
  [ "$RELEASE_PLATFORM" = linux/amd64 ] || { echo "$who: PLATFORM in $file must be linux/amd64" >&2; return 1; }
  [[ "$RELEASE_RUN_ID" =~ ^[0-9]{1,20}$ ]] || { echo "$who: RUN_ID in $file must be the numeric GitHub Actions run id" >&2; return 1; }
}

# kayas_require_release_checkout <who>: the host scripts and configuration are at the approved commit and no tracked file was edited.
kayas_require_release_checkout() {
  local who="$1" head
  head="$(git rev-parse HEAD 2>/dev/null)" || { echo "$who: this directory is not a git checkout" >&2; return 1; }
  if [ "$head" != "$RELEASE_COMMIT" ]; then
    echo "$who: the host files are at ${head:0:12}, the approved release is ${RELEASE_COMMIT:0:12}. Refused: check out the approved commit (scripts/ops/deploy.sh does it)." >&2; return 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "$who: a tracked file differs from the approved commit (scripts or configuration were edited on the host). Refused." >&2; return 1
  fi
}

# kayas_validate_effective <who> <stack> <compose-config-command...>: runs `config --format json` and pipes it into the validator (never printed).
kayas_validate_effective() {
  local who="$1" stack="$2"; shift 2
  command -v python3 >/dev/null || { echo "$who: python3 is required (it validates the effective configuration)" >&2; return 1; }
  "$@" | python3 -I scripts/ops/validate-compose.py --stack "$stack" --image "$RELEASE_IMAGE" --platform "$RELEASE_PLATFORM" ${KAYAS_VALIDATE_FLAGS[@]+"${KAYAS_VALIDATE_FLAGS[@]}"} \
    || { echo "$who: the effective compose configuration was refused; nothing was run." >&2; return 1; }
}

# kayas_check_run_args <stack> <run|exec> <args…>: the options before the service name are allow-listed. `run` could otherwise add a bind mount, an env
# variable, an entrypoint, a capability or a network that the effective-configuration check never saw. Everything after the service name is the command.
kayas_check_run_args() {
  local stack="$1" sub="$2" who="dc.sh" svc_ok; shift 2
  case "$stack:$sub" in
    prod:run) svc_ok=" ops bootstrap backup " ;; staging:run) svc_ok=" ops " ;;
    prod:exec|staging:exec) svc_ok=" app db proxy " ;;
    *) echo "$who: unknown stack/sub-command" >&2; return 1 ;;
  esac
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --rm|-T|-i|-t|-it|--no-deps|--interactive|--tty) shift ;;
      --name) [[ "${2:-}" =~ ^[A-Za-z0-9_.-]{1,80}$ ]] || { echo "$who: bad --name" >&2; return 1; }; shift 2 ;;
      --user) # only the staging credentials-folder job runs as root, with CHOWN/FOWNER only
        [ "$stack" = staging ] && [ "${2:-}" = root ] || { echo "$who: --user is refused here" >&2; return 1; }; shift 2 ;;
      --cap-add) [ "$stack" = staging ] && [[ "${2:-}" =~ ^(CHOWN|FOWNER)$ ]] || { echo "$who: --cap-add is refused here" >&2; return 1; }; shift 2 ;;
      -*) echo "$who: the option '$1' is not allowed before the service name (the effective configuration is fixed by the wrapper)." >&2; return 1 ;;
      *) case "$svc_ok" in *" $1 "*) return 0 ;; *) echo "$who: '$1' is not a service this sub-command may use." >&2; return 1 ;; esac ;;
    esac
  done
  echo "$who: a service name is required" >&2; return 1
}
