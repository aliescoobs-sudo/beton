#!/usr/bin/env bash
# Nightly encrypted backup on the SERVER (cron: 30 2 * * *  /srv/kayas/scripts/ops/backup-nightly.sh). ONE set per night: the
# database and the stored documents, both sealed with the age PUBLIC key, then the manifest (written last). The private key is not on
# this host, so this host cannot read its own backups. Keeps the last 14 sets. The copy to the office machine is PULLED from there by
# scripts/ops/backup-pull.sh. A failure sends an alert (scripts/ops/alert.sh) and exits non-zero.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.."
. ./scripts/ops/release-lib.sh
. ./scripts/ops/job-lib.sh
# T10g (R19B-02): the backup job runs the approved image only, from host files at the approved commit, and leaves execution evidence. A refusal here happens
# before the backup login's secret file is read by any container.
kayas_reject_overrides backup-nightly.sh
kayas_read_approved backup-nightly.sh
kayas_require_release_checkout backup-nightly.sh
JOB_TTY=no
trap '"$here/alert.sh" "nightly backup FAILED on $(hostname) (line $LINENO)"' ERR
kayas_run_job ./scripts/ops/dc.sh release/evidence/jobs.jsonl backup backup -- node --import ./scripts/register-ts-paths.mjs scripts/backup.ts
latest=$(ls -1t backups/*.audit-anchor.json | head -n 1)
kayas_run_job ./scripts/ops/dc.sh release/evidence/jobs.jsonl backup-verify backup -- node --import ./scripts/register-ts-paths.mjs scripts/backup-verify.ts check "$latest" --max-age-hours 1
# keep 14 sets (database, documents, manifest), oldest first out
ls -1t backups/*.audit-anchor.json | tail -n +15 | while read -r f; do
  base="${f%.audit-anchor.json}"
  rm -f -- "$base.sql.age" "$base.files.tar.age" "$base.audit-anchor.json"
done
echo "backup ok: $latest"
