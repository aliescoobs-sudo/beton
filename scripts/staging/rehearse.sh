#!/usr/bin/env bash
# LOCAL REHEARSAL of the staging stack (T10g, R19B-01 proof). Starts the REAL docker-compose.staging.yml and the REAL Caddyfile.staging on this machine
# (loopback ports 18080/18443, Caddy's internal CA, a *.localhost name), with dummy secrets and canary Basic credentials, runs the checks, then removes
# everything (containers, volumes, env files, hash file). It contacts no remote host and needs no registry: the image is built from this checkout.
#   ./scripts/staging/rehearse.sh [--no-build] [--keep]
# The image runs by its content id, not by a registry digest: this proves the CONFIGURATION, not a released artifact. The VPS run uses the approved digest.
# Refuses to run when a real .env.staging, staging/basic-auth.caddy or kayas-staging volume exists.
set -euo pipefail
cd "$(dirname "$0")/../.."
build=yes; keep=no
for a in "$@"; do case "$a" in --no-build) build=no ;; --keep) keep=yes ;; *) echo "rehearse.sh: unknown option $a" >&2; exit 2 ;; esac; done
for f in .env.staging .env.staging.ops staging/basic-auth.caddy; do [ ! -e "$f" ] || { echo "rehearse.sh: $f exists: this directory is not clean for a rehearsal" >&2; exit 1; }; done
if [ -n "$(docker volume ls -q --filter label=com.docker.compose.project=kayas-staging)" ]; then echo "rehearse.sh: kayas-staging volumes exist: refusing to touch them" >&2; exit 1; fi
mkdir -p .logs
if [ "$build" = yes ]; then docker build -t kayas-rehearsal:local . > .logs/rehearsal-build.log 2>&1 || { echo "rehearse.sh: image build failed (see .logs/rehearsal-build.log)" >&2; exit 1; }; fi
image_id="$(docker image inspect kayas-rehearsal:local --format '{{.Id}}')"
arch="$(docker image inspect kayas-rehearsal:local --format '{{.Os}}/{{.Architecture}}')"
export REHEARSAL_HTTP=18080 REHEARSAL_HTTPS=18443 REHEARSAL_HOST=kayas-staging.localhost
export REHEARSAL_USER=rehearsal-user REHEARSAL_PASSWORD="canary-basic-pw-$(openssl rand -hex 6)" REHEARSAL_WRONG=wrong-canary-pw-0123456789

cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$keep" = no ]; then
    ./scripts/staging/dc.sh stop-all >/dev/null 2>&1 || true
    ./scripts/staging/dc.sh down --remove-orphans >/dev/null 2>&1 || true
    for v in pgdata filestore accounts caddy_data; do docker volume rm "kayas-staging_$v" >/dev/null 2>&1 || true; done
    docker rm -f kayas-rehearsal-echo kayas-rehearsal-proxy2 >/dev/null 2>&1 || true
    rm -rf .env.staging .env.staging.ops staging/basic-auth.caddy .staging-evidence
  else
    echo "rehearse.sh: --keep: the rehearsal stack, .env.staging, .env.staging.ops and staging/basic-auth.caddy are left in place; remove them by hand"
  fi
  exit "$rc"
}
trap cleanup EXIT

# 1. the env files, made by the real init script, then switched to rehearsal values (loopback high ports, internal CA, local image)
APP_DOMAIN="$REHEARSAL_HOST" ./scripts/staging/init-env.sh >/dev/null
sed -i.bak -e 's#^STAGING_TLS=.*#STAGING_TLS=internal#' .env.staging && rm -f .env.staging.bak
{
  echo "STAGING_REHEARSAL=1"
  echo "REHEARSAL_IMAGE=$image_id"
  echo "STAGING_PLATFORM=$arch"
  echo "STAGING_BIND_IP=127.0.0.1"
  echo "STAGING_HTTP_PORT=$REHEARSAL_HTTP"
  echo "STAGING_HTTPS_PORT=$REHEARSAL_HTTPS"
} >> .env.staging
sed -i.bak "s#^APP_BASE_URL=.*#APP_BASE_URL=https://$REHEARSAL_HOST:$REHEARSAL_HTTPS#" .env.staging && rm -f .env.staging.bak
chmod 600 .env.staging .env.staging.ops

# 2. the Basic Auth hash, through the real script (batch mode: three lines on stdin)
printf '%s\n%s\n%s\n' "$REHEARSAL_USER" "$REHEARSAL_PASSWORD" "$REHEARSAL_PASSWORD" | KAYAS_BASIC_BATCH=1 ./scripts/staging/make-basic.sh

# 3. the real ordered first start
READY_SLEEP=3 BOUNDARY_PAUSE=8 ./scripts/staging/up.sh

# 4. the checks
./scripts/staging/rehearsal-checks.sh
# 5. the browser checks (Basic Auth, login page, phone page, service worker), with Caddy's internal CA trusted by its public-key hash
spki=""
for crt in root intermediate; do
  ca="$(mktemp .logs/rehearsal-ca.XXXXXX)"
  ./scripts/staging/dc.sh exec -T proxy cat "/data/caddy/pki/authorities/local/$crt.crt" > "$ca"
  h="$(openssl x509 -in "$ca" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)"
  rm -f "$ca"
  spki="${spki:+$spki,}$h"
done
REHEARSAL_SPKI="$spki"
export REHEARSAL_SPKI
corepack pnpm exec playwright test -c playwright.staging.config.ts
echo "rehearse.sh: all checks passed (image $image_id, $arch)"
