#!/usr/bin/env bash
# Nightly dump of the training database to a folder OUTSIDE the repository (default ~/belgobeton-training-backups), 14 kept.
# The data are fictitious, so the dump is not encrypted; the folder is mode 700. Not a production backup.
#   ./scripts/training-backup.sh
# Schedule it (see CP-TRAINING.md): launchd or cron at 02:30.
set -euo pipefail
cd "$(dirname "$0")/.."
dest="${TRAINING_BACKUP_DIR:-$HOME/belgobeton-training-backups}"
case "$(cd "$dest" 2>/dev/null && pwd || echo "$dest")" in "$(pwd)"|"$(pwd)"/*) echo "training-backup.sh: the backup folder must be outside the repository" >&2; exit 2;; esac
mkdir -p "$dest" && chmod 700 "$dest"
stamp=$(date +%Y%m%d-%H%M%S)
tmp="$dest/.training-$stamp.dump.part"
./scripts/training/dc.sh exec -T db pg_dump -U postgres -Fc belgobeton > "$tmp"
[ -s "$tmp" ] || { rm -f "$tmp"; echo "training-backup.sh: empty dump" >&2; exit 1; }
mv "$tmp" "$dest/training-$stamp.dump"
chmod 600 "$dest/training-$stamp.dump"
ls -1t "$dest"/training-*.dump | tail -n +15 | xargs -I{} rm -f {}
echo "training-backup.sh: wrote $dest/training-$stamp.dump"
