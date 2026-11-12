#!/usr/bin/env bash
# The switch-state journal and the approval writer of a deployment (T10g, R19B-08). Sourced; defines functions only.
# The journal is an append-only file, one JSON line per state, mode 0640: begin, refused, failed_before_switch, pulled, backup_ok, switched, migrated, started,
# ready, done, rollback_started, rollback_verified, ROLLBACK_FAILED, recovered. A state that is not terminal means a deployment was interrupted.
KAYAS_JOURNAL=release/.deploy-journal
kayas_journal() { # <state> <detail>
  local state="$1" detail="${2:-}"
  detail="${detail//\"/\'}"; detail="${detail//\\/ }"
  printf '{"at":"%s","state":"%s","detail":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$state" "$detail" >> "$KAYAS_JOURNAL"
}
kayas_journal_last() { # sets LAST_STATE from the last line
  LAST_STATE=""
  [ -s "$KAYAS_JOURNAL" ] || return 0
  LAST_STATE="$(tail -n 1 "$KAYAS_JOURNAL" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
}
kayas_write_approved() { # commit image platform run_id : atomic
  local tmp; tmp="$(umask 027; mktemp release/.APPROVED.XXXXXX)"
  { echo "# KAYAS approved release. Written by scripts/ops/deploy.sh or approve-release.sh; do not edit."
    echo "COMMIT=$1"; echo "IMAGE=$2"; echo "PLATFORM=$3"; echo "RUN_ID=$4"; } > "$tmp"
  chmod 640 "$tmp"
  mv -f -- "$tmp" release/APPROVED
}
