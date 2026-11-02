#!/usr/bin/env bash
# Nightly encrypted backup on the SERVER (cron: 30 2 * * *). Seals a dump with the age PUBLIC key, writes the audit anchor, keeps
# the last 14 sets, and checks that the newest file is not empty. The private key is not on this host, so this host cannot read its
# own backups. The copy to the office machine is PULLED from there by scripts/ops/backup-pull.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.prod.yml run --rm -T ops corepack pnpm backup
latest=$(ls -1t backups/*.sql.age | head -n 1)
[ -s "$latest" ] || { echo "backup is empty: $latest" >&2; exit 1; }
# keep 14 sets (dump + anchor), oldest first out
ls -1t backups/*.sql.age | tail -n +15 | while read -r f; do rm -f -- "$f" "${f%.sql.age}.audit-anchor.json"; done
echo "backup ok: $latest"
