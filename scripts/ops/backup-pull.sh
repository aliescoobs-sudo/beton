#!/usr/bin/env bash
# Nightly PULL of the encrypted backups to the OFFICE machine (cron or launchd, e.g. 04:00). The office machine initiates the
# connection with its own SSH key (read-only account on the server); the server holds no key to the office machine and no copy
# of the age private key. Verifies that the file arrived intact (sha256) and keeps the last 30 sets.
#   SERVER=user@server.example BACKUP_DIR=~/belgobeton-backups ./backup-pull.sh
set -euo pipefail
: "${SERVER:?set SERVER, e.g. backup@server.example}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/belgobeton-backups}"
REMOTE_DIR="${REMOTE_DIR:-/srv/belgobeton/backups}"
mkdir -p "$BACKUP_DIR"
umask 077
# only the sealed dumps and their anchors are fetched; nothing else on the server is read
rsync -a --ignore-existing --include='*.sql.age' --include='*.audit-anchor.json' --exclude='*' -e "ssh -o BatchMode=yes" \
  "$SERVER:$REMOTE_DIR/" "$BACKUP_DIR/"
newest=$(ls -1t "$BACKUP_DIR"/*.sql.age | head -n 1)
[ -s "$newest" ] || { echo "no usable backup arrived" >&2; exit 1; }
# the remote checksum must equal the local one for the newest set
remote_sum=$(ssh -o BatchMode=yes "$SERVER" "sha256sum '$REMOTE_DIR/$(basename "$newest")'" | cut -d' ' -f1)
local_sum=$(shasum -a 256 "$newest" | cut -d' ' -f1)
[ "$remote_sum" = "$local_sum" ] || { echo "checksum mismatch for $newest" >&2; exit 1; }
ls -1t "$BACKUP_DIR"/*.sql.age | tail -n +31 | while read -r f; do rm -f -- "$f" "${f%.sql.age}.audit-anchor.json"; done
echo "pulled and verified: $newest"
