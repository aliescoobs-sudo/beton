#!/usr/bin/env bash
# One-time preparation of the host directories (run as root on a new server). CODEX-REVIEW-R9 item 10, CODEX-REVIEW-FINAL F04.
#   sudo ./scripts/ops/init-host.sh <backup-pull-user> [<deploy-user>]      (deploy-user defaults to $SUDO_USER)
# The containers run as uid/gid 10001 (user "app"). Backups are written there with the group of the directory (setgid) and mode 0640:
# the pull account joins group "belgobeton-backup", so it can READ the sealed sets and cannot write or delete them. (An ACL is not
# used on purpose: chmod 0600 on a file resets the ACL mask and silently locks the reader out.)
# keys/ and reports/ are written by the DEPLOY account (the public signing key, the signed restore reports) and read by the container
# through its group 10001: owner = deploy user, group 10001, mode 2750 (setgid, so what the deploy user uploads belongs to group 10001).
# After an upload the files need mode 0640 (see the runbook); a file the container cannot read is reported by the script that reads it.
set -euo pipefail
puller="${1:?usage: init-host.sh <backup-pull-user> [<deploy-user>]}"
deployer="${2:-${SUDO_USER:-}}"
[ -n "$deployer" ] && [ "$deployer" != root ] || { echo "init-host.sh: name the non-root deploy user (second argument)" >&2; exit 2; }
id "$deployer" >/dev/null
root="$(cd "$(dirname "$0")/../.." && pwd)"
getent group belgobeton-backup >/dev/null || groupadd --system belgobeton-backup
usermod -aG belgobeton-backup "$puller"
install -d -o 10001 -g belgobeton-backup -m 2750 "$root/backups"
install -d -o 10001 -g 10001 -m 0750 "$root/imports"
install -d -o "$deployer" -g 10001 -m 2750 "$root/keys" "$root/reports"
chmod 600 "$root"/.env.prod "$root"/.env.ops.prod "$root"/.env.backup.prod 2>/dev/null || true
echo "backups/ is 2750 owner 10001 group belgobeton-backup; $puller can read it. The named volume 'filestore' is created owned by uid 10001 by the image."
echo "keys/ and reports/ are 2750 owner $deployer group 10001: $deployer uploads, the container reads."
echo "Check as $puller: it can list and read backups/ but 'touch backups/x' must fail."
