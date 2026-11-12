#!/usr/bin/env bash
# Starts the STAGING stack in the one order that is safe (T10g, R19B-01/-12 of the report's prerequisite list):
#   pull -> credentials folder -> DATABASE ONLY -> role bootstrap -> migrations -> FRESH training seed -> app + readiness + reserved-boundary check -> PROXY.
# The proxy (the only published service) starts last, and only when the Basic Auth hash file exists. Safe to run again: an already seeded database is
# left alone. The seed refuses a database without a fresh birth marker (a volume that was not created by this stack). Nothing is printed from the secrets.
#   ./scripts/staging/up.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
dc=./scripts/staging/dc.sh
ops=./scripts/staging/ops.sh
for f in .env.staging .env.staging.ops; do [ -r "$f" ] || { echo "up.sh: $f is missing: run ./scripts/staging/init-env.sh first" >&2; exit 1; }; done
[ -f staging/basic-auth.caddy ] || { echo "up.sh: staging/basic-auth.caddy is missing: run ./scripts/staging/make-basic.sh first (the proxy never starts without its gate)" >&2; exit 1; }
if [ -n "${APP_IMAGE+x}" ]; then echo "up.sh: APP_IMAGE is set in the shell. Refused: the image comes from .env.staging only." >&2; exit 1; fi
docker info >/dev/null 2>&1 || { echo "up.sh: Docker does not answer" >&2; exit 1; }
rehearsal=no; grep -q -E '^STAGING_REHEARSAL=1$' .env.staging && rehearsal=yes
[ "$rehearsal" = yes ] || $dc pull
$ops --prepare-out
$dc up -d --wait db
$ops db-bootstrap
$ops db-migrate
$ops seed-training
$dc up -d --wait app
ready=no
for _ in $(seq 1 "${READY_TRIES:-30}"); do
  if $dc exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready 2>/dev/null | grep -q '"ready"'; then ready=yes; break; fi
  sleep "${READY_SLEEP:-5}"
done
[ "$ready" = yes ] || { echo "up.sh: the app did not become ready: look at  ./scripts/staging/dc.sh logs app" >&2; exit 1; }
# The app refuses to boot when the reserved-role boundary is missing or off, or a reserved account is usable (platform-security boot probe): an app
# that is still running and ready after a pause has passed that probe. A restart or an exit here is a failed start-up.
sleep "${BOUNDARY_PAUSE:-10}"
state="$($dc ps --format '{{.Service}} {{.State}} {{.Health}}' app)"
case "$state" in "app running healthy") ;; *) echo "up.sh: the app is not running and healthy after the boot probe ($state): the proxy is NOT started" >&2; exit 1 ;; esac
$dc exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready | grep -q '"ready"' || { echo "up.sh: the app stopped answering readiness: the proxy is NOT started" >&2; exit 1; }
$dc up-proxy
cat <<'NEXT'

The staging stack is up. The proxy answers on 80/443 with Basic Auth in front of every path.
Next, by hand (docs/STAGING-VPS.md, steps 12-14): enrol the owner/admin TOTP through the HTTPS site, then run the external checks BEFORE sharing the address.
NEXT
