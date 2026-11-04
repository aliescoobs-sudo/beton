#!/usr/bin/env bash
# Creates the database roles and the database on a new server (F04). The only step that needs the password of the backup login outside
# the backup job: it is read from a TEMPORARY file, `.env.bootstrap.prod`, that holds that one variable and nothing else, and the file is
# deleted when the run succeeds. The app and the maintenance container never see it.
#   printf 'DATABASE_URL_BACKUP=postgres://belgobeton_backup:<password>@db:5432/belgobeton\n' > .env.bootstrap.prod && chmod 600 .env.bootstrap.prod
#   ./scripts/ops/bootstrap.sh
# DC (tests only) replaces the compose wrapper.
set -euo pipefail
cd "$(dirname "$0")/../.."
file=.env.bootstrap.prod
[ -r "$file" ] || { echo "bootstrap.sh: $file not found: create it with DATABASE_URL_BACKUP only (see the runbook, section 3)" >&2; exit 1; }
if grep -Ev '^(DATABASE_URL_BACKUP=[^[:space:]]+|[[:space:]]*|#.*)$' "$file" >/dev/null; then
  echo "bootstrap.sh: $file may contain DATABASE_URL_BACKUP and nothing else (no other secret goes through the bootstrap file)" >&2
  exit 1
fi
grep -q '^DATABASE_URL_BACKUP=' "$file" || { echo "bootstrap.sh: $file has no DATABASE_URL_BACKUP" >&2; exit 1; }
chmod 600 "$file"
"${DC:-./scripts/ops/dc.sh}" run --rm -T bootstrap node --import ./scripts/register-ts-paths.mjs scripts/db-bootstrap.ts
rm -f "$file"
echo "bootstrap.sh: done; $file deleted (the backup login now lives only in .env.backup.prod)."
