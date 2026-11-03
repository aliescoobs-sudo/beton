#!/usr/bin/env bash
# Nightly PULL of the encrypted backup sets to the OFFICE machine (cron or launchd, e.g. 04:00). The office machine opens the
# connection with its own SSH key (read-only account on the server); the server holds no key to the office machine, no copy of the
# age private key and no signing key. The pull is staged, then verified before anything reaches the store (CODEX-REVIEW-R9 items 8, 9):
#   - a set counts only with its manifest (written last on the server), so a half-written dump is never taken;
#   - both archives must match the sha256 and size in the manifest;
#   - the newest set must be younger than MAX_AGE_HOURS (default 30), else the backup job is late;
#   - a set the office signed before must be identical on the server (a rewrite is reported);
#   - each new set gets a receipt signed with SIGNING_KEY_FILE, which every restore checks;
#   - any problem sends an alert (scripts/ops/alert.sh) and exits non-zero. Nothing is "ignored if present": a damaged local copy is
#     replaced by a good one from the server.
#   SERVER=backup@server.example SIGNING_KEY_FILE=~/belgobeton-keys/backup-signing.key BACKUP_DIR=~/belgobeton-backups ./backup-pull.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
: "${SERVER:?set SERVER, e.g. backup@server.example}"
: "${SIGNING_KEY_FILE:?set SIGNING_KEY_FILE to the office ed25519 private key (node scripts/backup-verify.ts keygen <dir>)}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/belgobeton-backups}"
REMOTE_DIR="${REMOTE_DIR:-/srv/belgobeton/backups}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-30}"
mkdir -p "$BACKUP_DIR"
umask 077
stage="$(mktemp -d "$BACKUP_DIR/.incoming.XXXXXX")"
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT
trap '"$here/alert.sh" "backup PULL FAILED (line $LINENO) on $(hostname): see the job log"' ERR
# only the sealed archives and manifests are fetched; nothing else on the server is read
rsync -a --partial --include='*.sql.age' --include='*.files.tar.age' --include='*.audit-anchor.json' --exclude='*' \
  -e "ssh -o BatchMode=yes" "$SERVER:$REMOTE_DIR/" "$stage/"
cd "$repo"
if ! node --import ./scripts/register-ts-paths.mjs scripts/backup-verify.ts ingest "$stage" "$BACKUP_DIR" \
  --key "$SIGNING_KEY_FILE" --max-age-hours "$MAX_AGE_HOURS" --keep 30; then
  "$here/alert.sh" "backup pull found problems (stale, incomplete, damaged or rewritten set): see the job log"
  exit 1
fi
date -u +%FT%TZ > "$BACKUP_DIR/.last-pull-ok"
echo "pulled and verified into $BACKUP_DIR"
