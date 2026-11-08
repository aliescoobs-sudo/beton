#!/usr/bin/env bash
# Nightly encrypted backup on the SERVER (cron: 30 2 * * *  /srv/kayas/scripts/ops/backup-nightly.sh). ONE set per night: the
# database and the stored documents, both sealed with the age PUBLIC key, then the manifest (written last). The private key is not on
# this host, so this host cannot read its own backups. Keeps the last 14 sets. The copy to the office machine is PULLED from there by
# scripts/ops/backup-pull.sh. A failure sends an alert (scripts/ops/alert.sh) and exits non-zero.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.."
trap '"$here/alert.sh" "nightly backup FAILED on $(hostname) (line $LINENO)"' ERR
./scripts/ops/dc.sh run --rm -T backup node --import ./scripts/register-ts-paths.mjs scripts/backup.ts
latest=$(ls -1t backups/*.audit-anchor.json | head -n 1)
./scripts/ops/dc.sh run --rm -T backup node --import ./scripts/register-ts-paths.mjs scripts/backup-verify.ts check "$latest" --max-age-hours 1
# keep 14 sets (database, documents, manifest), oldest first out
ls -1t backups/*.audit-anchor.json | tail -n +15 | while read -r f; do
  base="${f%.audit-anchor.json}"
  rm -f -- "$base.sql.age" "$base.files.tar.age" "$base.audit-anchor.json"
done
echo "backup ok: $latest"
