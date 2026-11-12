#!/usr/bin/env bash
# Creates the database roles and the database on a new server (F04). The only step that needs the password of the backup login outside the backup job:
# it is read from a TEMPORARY file, `.env.bootstrap.prod`, that holds that one variable and nothing else, and the file is deleted when the run succeeds.
# The app and the maintenance container never see it. T10g: bound to the approved release like every privileged job (scripts/ops/release-lib.sh).
# R19B-04: the file is created PRIVATE FROM ITS FIRST BYTE, and the password is typed at a hidden prompt, never as an argument or a shell-history line:
#   ./scripts/ops/bootstrap.sh --create-env       (asks for the backup login's password twice, hidden; writes .env.bootstrap.prod with mode 0600)
#   ./scripts/ops/bootstrap.sh                    (runs the bootstrap job, then deletes the file)
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
. ./scripts/ops/job-lib.sh
file=.env.bootstrap.prod
if [ "${1:-}" = --create-env ]; then
  [ ! -e "$file" ] && [ ! -L "$file" ] || { echo "bootstrap.sh: $file already exists" >&2; exit 1; }
  { [ -t 0 ] && [ -t 2 ]; } || { echo "bootstrap.sh: --create-env needs a terminal (hidden prompt)" >&2; exit 1; }
  IFS= read -r -s -p "Password of the backup login (the one in .env.backup.prod, URL-safe characters only): " pw </dev/tty; echo >&2
  [[ "$pw" =~ ^[A-Za-z0-9._~-]{16,}$ ]] || { echo "bootstrap.sh: the password must be at least 16 URL-safe characters (letters, digits . _ ~ -)" >&2; exit 1; }
  tmp="$(mktemp .env.bootstrap.XXXXXX)"            # mktemp creates the file exclusively, mode 0600
  printf 'DATABASE_URL_BACKUP=postgres://belgobeton_backup:%s@db:5432/belgobeton\n' "$pw" > "$tmp"
  unset pw
  mv -f -- "$tmp" "$file"
  echo "bootstrap.sh: wrote $file (mode 0600)."
  exit 0
fi
[ -r "$file" ] || { echo "bootstrap.sh: $file not found: run  ./scripts/ops/bootstrap.sh --create-env  first (see the runbook, section 3)" >&2; exit 1; }
[ ! -L "$file" ] || { echo "bootstrap.sh: $file is a link: refused" >&2; exit 1; }
if grep -Ev '^(DATABASE_URL_BACKUP=[^[:space:]]+|[[:space:]]*|#.*)$' "$file" >/dev/null; then
  echo "bootstrap.sh: $file may contain DATABASE_URL_BACKUP and nothing else (no other secret goes through the bootstrap file)" >&2
  exit 1
fi
grep -q '^DATABASE_URL_BACKUP=' "$file" || { echo "bootstrap.sh: $file has no DATABASE_URL_BACKUP" >&2; exit 1; }
chmod 600 "$file"
kayas_reject_overrides bootstrap.sh
kayas_read_approved bootstrap.sh
kayas_require_release_checkout bootstrap.sh
JOB_TTY=no
kayas_run_job ./scripts/ops/dc.sh release/evidence/jobs.jsonl db-bootstrap bootstrap -- node --import ./scripts/register-ts-paths.mjs scripts/db-bootstrap.ts
rm -f "$file"
echo "bootstrap.sh: done; $file deleted (the backup login now lives only in .env.backup.prod)."
