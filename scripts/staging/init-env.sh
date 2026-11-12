#!/usr/bin/env bash
# Writes .env.staging and .env.staging.ops with fresh random secrets (once; refuses to overwrite). Needs openssl. Run under the deploy account.
#   APP_DOMAIN=kayas.example.com ./scripts/staging/init-env.sh
# The origin is https://$APP_DOMAIN and nothing else. The secrets are written to the two files only (mode 0600 from the first byte) and are not printed.
# The image is NOT in these files: it comes from release/APPROVED (scripts/ops/approve-release.sh). There is NO provider key, NO VAPID key and NO Basic Auth hash in these files (the hash is a file of its own: scripts/staging/make-basic.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
domain="${APP_DOMAIN:?set APP_DOMAIN (the host name of the staging site, e.g. kayas.example.com)}"
if ! [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then echo "init-env.sh: APP_DOMAIN must be a lowercase host name with at least one dot (no scheme, no port, no path)" >&2; exit 1; fi
base="https://$domain"
for f in .env.staging .env.staging.ops; do
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
  echo "STAGING_TLS=acme"
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
} > .env.staging || { echo "init-env.sh: could not create .env.staging exclusively (planted file or link?): nothing written" >&2; exit 1; }
created+=(.env.staging)
{
  echo "POSTGRES_SUPERUSER_PASSWORD=$pw_super"
  echo "DATABASE_URL_MIGRATOR=postgres://belgobeton_migrator:$pw_migrator@db:5432/belgobeton"
  echo "DATABASE_URL_BACKUP=postgres://belgobeton_backup:$pw_backup@db:5432/belgobeton"
  echo "DATABASE_URL_SEED=postgres://belgobeton_seed:$pw_seed@db:5432/belgobeton"
} > .env.staging.ops || { echo "init-env.sh: could not create .env.staging.ops exclusively (planted file or link?): nothing written" >&2; exit 1; }
created+=(.env.staging.ops)
chmod 600 .env.staging .env.staging.ops
echo "init-env.sh: wrote .env.staging and .env.staging.ops (chmod 600). Not shown here."
