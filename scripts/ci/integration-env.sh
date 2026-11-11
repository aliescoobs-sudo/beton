#!/usr/bin/env bash
# Prints the environment (KEY=VALUE lines) the integration tests need against a THROWAWAY PostgreSQL: random, CI-only secrets, nothing real.
#   scripts/ci/integration-env.sh [host] [port] >> "$GITHUB_ENV"
# The PostgreSQL superuser password is read from PGSUPER (set by the workflow for the service container).
set -euo pipefail
host="${1:-localhost}" port="${2:-5432}"
: "${PGSUPER:?PGSUPER must hold the superuser password of the service database}"
rnd() { openssl rand -hex 24; }
db=belgobeton
echo "NODE_ENV=test"
echo "POSTGRES_SUPERUSER_PASSWORD=$PGSUPER"
for r in app auth system migrator backup seed; do
  echo "DATABASE_URL_$(printf %s "$r" | tr a-z A-Z)=postgres://belgobeton_${r}:$(rnd)@${host}:${port}/${db}"
done
echo "AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo "FIELD_ENCRYPTION_KEYS=k1:$(openssl rand -base64 32)"
echo "RECOVERY_CODES_KEYS=r1:$(openssl rand -base64 32)"
echo "LOOKUP_HMAC_KEY=$(openssl rand -base64 32)"
# a throwaway age key pair for the backup/restore suite (the private key stays in the runner's temp folder)
idfile="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-age-identity.txt"
rm -f "$idfile"
age-keygen -o "$idfile" 2>/dev/null
chmod 600 "$idfile"
echo "BACKUP_AGE_RECIPIENT=$(age-keygen -y "$idfile")"
echo "BACKUP_AGE_IDENTITY_FILE=$idfile"
echo "SIMULATION_ENABLED=true"
echo "REAL_DATA=false"
echo "APP_BASE_URL=http://localhost:3000"
