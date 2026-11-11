#!/usr/bin/env bash
# Writes .env.training and .env.training.ops with fresh random secrets (once; refuses to overwrite). Needs openssl.
#   APP_IMAGE=ghcr.io/<owner>/kayas@sha256:<digest> ./scripts/training/init-env.sh
#   APP_BASE_URL (optional) is the address people type: local only, http://127.0.0.1:3000 by default (`set-url.sh http://localhost:3000`
#   changes it later). The app only accepts writes that come from that address.
# The secrets are written to the two files only (chmod 600) and are not printed.
set -euo pipefail
cd "$(dirname "$0")/../.."
base="${APP_BASE_URL:-http://127.0.0.1:3000}"
domain="${APP_DOMAIN:-}"
image="${APP_IMAGE:?set APP_IMAGE (ghcr.io/<owner>/kayas@sha256:<digest>)}"
# R18-11: the commit the digest was approved for (the one pick-image.sh printed) and the platform it runs on, recorded next to the digest so that every
# maintenance run can be compared with them (scripts/training/ops.sh). Optional; recorded as "unrecorded" when absent.
commit="${APP_COMMIT:-}"
platform="${APP_PLATFORM:-linux/amd64}"
case "$commit" in ''|[0-9a-f][0-9a-f]*) ;; *) echo "init-env.sh: APP_COMMIT must be 40 lowercase hex characters" >&2; exit 1 ;; esac
[ -z "$commit" ] || [ "${#commit}" = 40 ] || { echo "init-env.sh: APP_COMMIT must be 40 lowercase hex characters" >&2; exit 1; }
case "$platform" in linux/amd64|linux/arm64) ;; *) echo "init-env.sh: APP_PLATFORM must be linux/amd64 or linux/arm64" >&2; exit 1 ;; esac
. ./scripts/training/image-policy.sh
kayas_require_image "$image" init-env.sh
for f in .env.training .env.training.ops; do
  { [ -e "$f" ] || [ -L "$f" ]; } && { echo "init-env.sh: $f already exists (or is a link): not overwritten" >&2; exit 1; }
done
rnd() { openssl rand -hex 24; }
key() { openssl rand -base64 32; }
umask 077
# R12: the two files are created EXCLUSIVELY (noclobber = O_EXCL): a file or a link planted between the check above and the write makes the
# write fail instead of being followed. Mode 0600 from the start (umask), and a failure removes what this run created.
set -C
created=()
trap 'rc=$?; if [ "$rc" -ne 0 ]; then for f in "${created[@]:-}"; do [ -n "$f" ] && rm -f -- "$f"; done; fi' EXIT
pw_app=$(rnd) pw_auth=$(rnd) pw_system=$(rnd) pw_migrator=$(rnd) pw_backup=$(rnd) pw_seed=$(rnd) pw_super=$(rnd)
{
  echo "APP_DOMAIN=$domain"
  echo "APP_PORT=3000"
  echo "APP_IMAGE=$image"
  echo "APP_COMMIT=$commit"
  echo "APP_PLATFORM=$platform"
  echo "APP_BASE_URL=$base"
  echo "DATABASE_URL_APP=postgres://belgobeton_app:$pw_app@db:5432/belgobeton"
  echo "DATABASE_URL_AUTH=postgres://belgobeton_auth:$pw_auth@db:5432/belgobeton"
  echo "DATABASE_URL_SYSTEM=postgres://belgobeton_system:$pw_system@db:5432/belgobeton"
  echo "AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
  echo "FIELD_ENCRYPTION_KEYS=k1:$(key)"
  echo "RECOVERY_CODES_KEYS=r1:$(key)"
  echo "LOOKUP_HMAC_KEY=$(key)"
  # A well-formed public key is required by the environment check; no backup is made on the training instance, so nothing is sealed with it.
  echo "BACKUP_AGE_RECIPIENT=age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq"
  cat <<'FLAGS'
# Module flags: everything that has passing tests is on; the client and supplier portals do not exist as flags and stay off.
FIELD_APP_ENABLED=true
NOTIFICATIONS_ENABLED=true
CANCELLATIONS_ENABLED=true
DOCUMENTS_V1_ENABLED=true
DARIJA_ENABLED=true
ASSISTANT_DET_ENABLED=true
TRANSFERS_ENABLED=true
FINANCE_ENABLED=true
FLAGS
} > .env.training || { echo "init-env.sh: could not create .env.training exclusively (planted file or link?): nothing written" >&2; exit 1; }
created+=(.env.training)
{
  echo "POSTGRES_SUPERUSER_PASSWORD=$pw_super"
  echo "DATABASE_URL_MIGRATOR=postgres://belgobeton_migrator:$pw_migrator@db:5432/belgobeton"
  echo "DATABASE_URL_BACKUP=postgres://belgobeton_backup:$pw_backup@db:5432/belgobeton"
  echo "DATABASE_URL_SEED=postgres://belgobeton_seed:$pw_seed@db:5432/belgobeton"
} > .env.training.ops || { echo "init-env.sh: could not create .env.training.ops exclusively (planted file or link?): nothing written" >&2; exit 1; }
created+=(.env.training.ops)
chmod 600 .env.training .env.training.ops
echo "init-env.sh: wrote .env.training and .env.training.ops (chmod 600). Not shown here."
