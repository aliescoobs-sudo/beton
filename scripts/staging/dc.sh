#!/usr/bin/env bash
# The ONE way to run docker compose for the STAGING stack (T10g, R19B-01/-02). Same discipline as scripts/training/dc.sh:
#   1. no outside override: APP_IMAGE in the shell, COMPOSE_* variables, an APP_IMAGE in the second env file, a duplicated key, ANY option before the
#      sub-command (the sub-command is allow-listed and comes first; files, env files, project and profiles are built here and nowhere else);
#   2. the image is the accepted digest (ghcr.io/<owner>/kayas@sha256:<64 hex>, no tag), passed to compose explicitly;
#   3. what compose RESOLVED (env files and defaults included) is checked by scripts/ops/validate-compose.py BEFORE anything runs: service set, images,
#      published ports (proxy 80/443 only), mounts, capabilities, hardening, forced training/staging flags, absent provider keys. Nothing is printed
#      from the environment;
#   4. the Basic Auth hash file must exist as a regular file the proxy container can read (owner = deploy user, mode 0644, not group/world-writable) before any command that can start the proxy.
set -euo pipefail
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
for f in .env.staging .env.staging.ops; do [ -r "$f" ] || { echo "staging dc.sh: $f not found: run ./scripts/staging/init-env.sh first" >&2; exit 1; }; done
kayas_reject_overrides "staging dc.sh"
kayas_reject_env_file_image "staging dc.sh" .env.staging .env.staging.ops
# R20-09: the shell outranks an env file in Compose interpolation. Nothing the proxy, the image choice or the rehearsal read may come from the inherited
# environment: the fixed names below, and any variable that either env file defines (those would silently win over the file).
for v in APP_DOMAIN APP_BASE_URL STAGING_TLS STAGING_HTTP_PORT STAGING_HTTPS_PORT STAGING_BIND_IP STAGING_PLATFORM STAGING_REHEARSAL STAGING_PROFILE REHEARSAL_IMAGE POSTGRES_SUPERUSER_PASSWORD DOCKER_CONFIG BUILDKIT_HOST; do
  if [ -n "${!v+x}" ]; then echo "staging dc.sh: $v is set in the shell. Refused: the proxy domain, TLS mode, ports and rehearsal settings come from the private env files only." >&2; exit 1; fi
done
while IFS= read -r v; do
  if [ -n "${!v+x}" ]; then echo "staging dc.sh: $v is set in the shell and also defined in an env file. Refused: the shell value would override the file." >&2; exit 1; fi
done < <(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' .env.staging .env.staging.ops)
KAYAS_VALIDATE_FLAGS=()
rehearsal_flag=""
if grep -q -E '^STAGING_REHEARSAL=1$' .env.staging; then rehearsal_flag="--rehearsal"; KAYAS_VALIDATE_FLAGS=(--rehearsal); fi
if [ -n "$rehearsal_flag" ]; then
  # the LOCAL rehearsal runs the image it just built, by content id (never on a server: the validator refuses any non-loopback port in this mode)
  RELEASE_IMAGE="$(sed -n 's/^REHEARSAL_IMAGE=//p' .env.staging | head -n1)"
  [[ "$RELEASE_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "staging dc.sh: the rehearsal image must be a local image id (sha256:<64 hex>)" >&2; exit 1; }
  RELEASE_PLATFORM="$(sed -n 's/^STAGING_PLATFORM=//p' .env.staging | head -n1)"; RELEASE_PLATFORM="${RELEASE_PLATFORM:-linux/amd64}"
  RELEASE_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo rehearsal)"; RELEASE_RUN_ID=0
else
  # a real staging host: the image, the commit and the platform come from release/APPROVED, and the host files are at that commit
  if grep -q -E '^(REHEARSAL_IMAGE|STAGING_PLATFORM|STAGING_BIND_IP|STAGING_HTTP_PORT|STAGING_HTTPS_PORT)=' .env.staging; then
    echo "staging dc.sh: .env.staging carries rehearsal-only settings but not STAGING_REHEARSAL=1. Refused." >&2; exit 1
  fi
  kayas_read_approved "staging dc.sh"
  kayas_require_release_checkout "staging dc.sh"
fi
image="$RELEASE_IMAGE"; platform="$RELEASE_PLATFORM"
sub="${1:-}"
case "$sub" in
  config|pull|run|up|stop|exec|ps|logs|stop-all|up-proxy|down) ;;
  '') echo "staging dc.sh: a sub-command is required (config, pull, run, up, stop, exec, ps, logs, stop-all, up-proxy, down)." >&2; exit 1 ;;
  *) echo "staging dc.sh: '${sub%%=*}' is not an allowed first argument: only config, pull, run, up, stop, exec, ps, logs, stop-all, up-proxy and down, and no compose option before the sub-command (the configuration is fixed by this script)." >&2; exit 1 ;;
esac
shift
case "$sub" in run|exec) kayas_check_run_args staging "$sub" "$@" || exit 1 ;; esac
args=("$sub" "$@")
if [ "$sub" = stop-all ]; then args=(--profile ops stop "$@"); fi
if [ "$sub" = up-proxy ]; then args=(up -d --wait proxy "$@"); fi
# `down` never removes volumes here: staging data is reset on purpose with scripts/staging/reset.sh, not by accident
if [ "$sub" = down ]; then
  for a in "$@"; do case "$a" in -v|--volumes|--rmi*) echo "staging dc.sh: down with $a is refused here; use scripts/staging/reset.sh to discard the staging data." >&2; exit 1 ;; esac; done
  args=(--profile ops down "$@")
fi

base=(env APP_IMAGE="$image" docker compose -f docker-compose.staging.yml --env-file .env.staging --env-file .env.staging.ops)

# the effective configuration, every profile on, checked as a whole before anything runs (nothing of it is printed)
kayas_validate_effective "staging dc.sh" staging "${base[@]}" --profile ops config --format json

# 4. the Basic Auth gate must exist before the proxy can start (a missing bind-mount source would be created as a DIRECTORY by Docker)
needs_gate=no
case "$sub" in
  up-proxy) needs_gate=yes ;;
  up) # R21-02: the gate is skipped ONLY for an explicit list of db / app / ops with nothing else but the plain flags below. Anything that could start the
      # proxy (no service name, `proxy`, a value-taking option such as `--wait-timeout 60` or `-t 60` whose value must not be read as a service name,
      # `--scale proxy=1`, an unknown option or token) runs the gate. The very first start (`up -d --wait db`) stays possible without the hash file.
    needs_gate=yes; plain=yes; names=0
    for a in "$@"; do
      case "$a" in
        -d|--detach|--wait) ;;
        db|app|ops) names=$((names+1)) ;;
        *) plain=no ;;
      esac
    done
    if [ "$plain" = yes ] && [ "$names" -gt 0 ]; then needs_gate=no; fi ;;
esac
case "$needs_gate" in
  yes)
    hash=staging/basic-auth.caddy
    # The proxy container's root has no DAC_OVERRIDE: it reads the file only as "other" (the file belongs to the deploy user). So the file must be world-readable
    # and NOT writable by group or others; the directory must be a real directory that others can traverse and nobody but the owner can write.
    me="$(id -u)"
    owner() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }
    modeof() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
    if [ -L staging ] || [ ! -d staging ]; then echo "staging dc.sh: staging/ is missing, a link or not a directory." >&2; exit 1; fi
    dmode="$(modeof staging)"
    if [ "$(owner staging)" != "$me" ] || [ $((8#$dmode & 8#022)) -ne 0 ] || [ $((8#$dmode & 8#001)) -eq 0 ]; then
      echo "staging dc.sh: staging/ must belong to the current user, not be writable by group or others, and be traversable by others (mode 0755; it is $dmode)." >&2; exit 1
    fi
    if [ -L "$hash" ] || [ ! -f "$hash" ]; then echo "staging dc.sh: $hash is missing or not a regular file: run ./scripts/staging/make-basic.sh first." >&2; exit 1; fi
    [ "$(owner "$hash")" = "$me" ] || { echo "staging dc.sh: $hash does not belong to the current user." >&2; exit 1; }
    mode="$(modeof "$hash")"
    if [ $((8#$mode & 8#022)) -ne 0 ] || [ $((8#$mode & 8#004)) -eq 0 ]; then
      echo "staging dc.sh: $hash must be mode 0644: readable by the proxy container (its root has no DAC_OVERRIDE) and not writable by group or others (it is $mode). Run ./scripts/staging/make-basic.sh again or: chmod 644 $hash" >&2; exit 1
    fi
    grep -q -E '^basic_auth bcrypt ' "$hash" && grep -q -E '\$2[aby]\$' "$hash" || { echo "staging dc.sh: $hash does not look like a Basic Auth hash file." >&2; exit 1; }
    ;;
esac

exec "${base[@]}" "${args[@]}"
