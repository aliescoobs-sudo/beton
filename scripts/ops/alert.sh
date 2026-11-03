#!/usr/bin/env bash
# Sends an alert for a failed or late backup job. ALERT_CMD is a command that reads the message on stdin, e.g.
#   ALERT_CMD='mail -s "BELGOBETON backup" ali@example.com'     or    ALERT_CMD='curl -s -d @- https://ntfy.sh/<private-topic>'
# Put it in scripts/ops/alert.env (not in git) next to the cron job. Without it the failure goes to stderr (cron mails it) only.
set -uo pipefail
message="${1:-backup problem}"
here="$(dirname "$0")"
[ -r "$here/alert.env" ] && . "$here/alert.env"
echo "$(date -u +%FT%TZ) BELGOBETON: $message" >&2
if [ -n "${ALERT_CMD:-}" ]; then echo "BELGOBETON ($(hostname)): $message" | sh -c "$ALERT_CMD" || echo "alert.sh: the alert command failed" >&2; fi
