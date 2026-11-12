#!/usr/bin/env bash
# The ONE way to run docker compose for the STAGING stack (T10g, R19B-01/-02). Same discipline as scripts/training/dc.sh:
#   1. no outside override: APP_IMAGE in the shell, COMPOSE_* variables, an APP_IMAGE in the second env file, a duplicated key, ANY option before the
#      sub-command (the sub-command is allow-listed and comes first; files, env files, project and profiles are built here and nowhere else);
#   2. the image is the accepted digest (ghcr.io/<owner>/kayas@sha256:<64 hex>, no tag), passed to compose explicitly;
#   3. what compose RESOLVED (env files and defaults included) is checked by scripts/ops/validate-compose.py BEFORE anything runs: service set, images,
#      published ports (proxy 80/443 only), mounts, capabilities, hardening, forced training/staging flags, absent provider keys. Nothing is printed
#      from the environment;
#   4. the Basic Auth hash file must exist as a private regular file before any command that can start the proxy.
set -euo pipefail
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
for f in .env.staging .env.staging.ops; do [ -r "$f" ] || { echo "staging dc.sh: $f not found: run ./scripts/staging/init-env.sh first" >&2; exit 1; }; done
kayas_reject_overrides "staging dc.sh"
kayas_reject_env_file_image "staging dc.sh" .env.staging .env.staging.ops
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
  up) # `up -d --wait db` (no proxy) is fine; `up` with no service name, or naming the proxy, starts it
    names=0; for a in "$@"; do case "$a" in -*) ;; *) names=$((names+1)); [ "$a" = proxy ] && needs_gate=yes ;; esac; done
    [ "$names" -gt 0 ] || needs_gate=yes ;;
esac
case "$needs_gate" in
  yes)
    hash=staging/basic-auth.caddy
    if [ -L "$hash" ] || [ ! -f "$hash" ]; then echo "staging dc.sh: $hash is missing or not a regular file: run ./scripts/staging/make-basic.sh first." >&2; exit 1; fi
    mode="$(stat -c '%a' "$hash" 2>/dev/null || stat -f '%Lp' "$hash")"
    [ "$mode" = 600 ] || { echo "staging dc.sh: $hash must be mode 0600 (it is $mode)." >&2; exit 1; }
    grep -q -E '^basic_auth bcrypt ' "$hash" && grep -q -E '\$2[aby]\$' "$hash" || { echo "staging dc.sh: $hash does not look like a Basic Auth hash file." >&2; exit 1; }
    ;;
esac

exec "${base[@]}" "${args[@]}"
