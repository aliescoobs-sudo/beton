#!/usr/bin/env bash
# Writes .env.training and .env.training.ops with fresh random secrets (once; refuses to overwrite). Needs openssl.
#   APP_IMAGE=ghcr.io/<owner>/belgobeton@sha256:<digest> ./scripts/training/init-env.sh
#   APP_BASE_URL (optional) is the public address people type: the Tailscale Funnel URL once it exists (`set-url.sh` changes it later),
#   or the domain of a VPS. The app only accepts writes that come from that address.
# The secrets are written to the two files only (chmod 600) and are not printed.
set -euo pipefail
cd "$(dirname "$0")/../.."
base="${APP_BASE_URL:-http://127.0.0.1:3000}"
domain="${APP_DOMAIN:-}"
image="${APP_IMAGE:?set APP_IMAGE (ghcr.io/<owner>/belgobeton@sha256:<digest>)}"
[ ! -e .env.training ] && [ ! -e .env.training.ops ] || { echo "init-env.sh: .env.training or .env.training.ops already exists: not overwritten" >&2; exit 1; }
rnd() { openssl rand -hex 24; }
key() { openssl rand -base64 32; }
umask 077
pw_app=$(rnd) pw_auth=$(rnd) pw_system=$(rnd) pw_migrator=$(rnd) pw_backup=$(rnd) pw_seed=$(rnd) pw_super=$(rnd)
{
  echo "APP_DOMAIN=$domain"
  echo "APP_PORT=3000"
  echo "APP_IMAGE=$image"
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
} > .env.training
{
  echo "POSTGRES_SUPERUSER_PASSWORD=$pw_super"
  echo "DATABASE_URL_MIGRATOR=postgres://belgobeton_migrator:$pw_migrator@db:5432/belgobeton"
  echo "DATABASE_URL_BACKUP=postgres://belgobeton_backup:$pw_backup@db:5432/belgobeton"
  echo "DATABASE_URL_SEED=postgres://belgobeton_seed:$pw_seed@db:5432/belgobeton"
} > .env.training.ops
chmod 600 .env.training .env.training.ops
echo "init-env.sh: wrote .env.training and .env.training.ops (chmod 600). Not shown here."
