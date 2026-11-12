#!/usr/bin/env bash
# One-time preparation of the host directories (run as root on a new server). CODEX-REVIEW-R9 item 10, CODEX-REVIEW-FINAL F04.
#   sudo ./scripts/ops/init-host.sh <backup-pull-user> [<deploy-user>]      (deploy-user defaults to $SUDO_USER)
# The containers run as uid/gid 10001 (user "app"). Backups are written there with the group of the directory (setgid) and mode 0640:
# the pull account joins group "kayas-backup", so it can READ the sealed sets and cannot write or delete them. (An ACL is not
# used on purpose: chmod 0600 on a file resets the ACL mask and silently locks the reader out.)
# keys/ and reports/ are written by the DEPLOY account (the public signing key, the signed restore reports) and read by the container
# through its group 10001: owner = deploy user, group 10001, mode 2750 (setgid, so what the deploy user uploads belongs to group 10001).
# After an upload the files need mode 0640 (see the runbook); a file the container cannot read is reported by the script that reads it.
# T10g (R19B-09): imports/ is the workbook the deploy user uploads (read-only to the container); import-work/ is the one WRITABLE place of the import tools:
# import-work/mapping (the mapping files the tool writes and the deploy user replaces) and import-work/reports (mounted at /app/.logs: reports, mode 0600, read by the
# container user). The deploy user joins the group 10001 (created as kayas-app when the host has none) so that it can use the group-writable folder.
set -euo pipefail
puller="${1:?usage: init-host.sh <backup-pull-user> [<deploy-user>]}"
deployer="${2:-${SUDO_USER:-}}"
[ -n "$deployer" ] && [ "$deployer" != root ] || { echo "init-host.sh: name the non-root deploy user (second argument)" >&2; exit 2; }
id "$deployer" >/dev/null
root="$(cd "$(dirname "$0")/../.." && pwd)"
getent group kayas-backup >/dev/null || groupadd --system kayas-backup
usermod -aG kayas-backup "$puller"
install -d -o 10001 -g kayas-backup -m 2750 "$root/backups"
getent group 10001 >/dev/null || groupadd --system -g 10001 kayas-app
usermod -aG "$(getent group 10001 | cut -d: -f1)" "$deployer"
install -d -o "$deployer" -g 10001 -m 2750 "$root/imports"
install -d -o "$deployer" -g 10001 -m 2770 "$root/import-work" "$root/import-work/mapping" "$root/import-work/reports"
install -d -o "$deployer" -g 10001 -m 2750 "$root/keys" "$root/reports"
chmod 600 "$root"/.env.prod "$root"/.env.ops.prod "$root"/.env.backup.prod 2>/dev/null || true
echo "backups/ is 2750 owner 10001 group kayas-backup; $puller can read it. The named volume 'filestore' is created owned by uid 10001 by the image."
echo "imports/ is 2750 and import-work/ (mapping, reports) 2770, owner $deployer group 10001: the deploy user uploads the workbook, the tools write mapping files and reports."
echo "keys/ and reports/ are 2750 owner $deployer group 10001: $deployer uploads, the container reads."
echo "Check as $puller: it can list and read backups/ but 'touch backups/x' must fail."
