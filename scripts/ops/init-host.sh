#!/usr/bin/env bash
# One-time preparation of the host directories (run as root on a new server). CODEX-REVIEW-R9 item 10.
#   sudo ./scripts/ops/init-host.sh <backup-pull-user>
# The containers run as uid/gid 10001 (user "app"). Backups are written there with the group of the directory (setgid) and mode 0640:
# the pull account joins group "belgobeton-backup", so it can READ the sealed sets and cannot write or delete them. (An ACL is not
# used on purpose: chmod 0600 on a file resets the ACL mask and silently locks the reader out.)
set -euo pipefail
puller="${1:?usage: init-host.sh <backup-pull-user>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
getent group belgobeton-backup >/dev/null || groupadd --system belgobeton-backup
usermod -aG belgobeton-backup "$puller"
install -d -o 10001 -g belgobeton-backup -m 2750 "$root/backups"
install -d -o 10001 -g 10001 -m 0750 "$root/imports"
install -d -m 0750 "$root/reports" "$root/keys"
chmod 600 "$root"/.env.prod "$root"/.env.ops.prod "$root"/.env.backup.prod 2>/dev/null || true
echo "backups/ is 2750 owner 10001 group belgobeton-backup; $puller can read it. The named volume 'filestore' is created owned by uid 10001 by the image."
echo "Check as $puller: it can list and read backups/ but 'touch backups/x' must fail."
