#!/usr/bin/env bash
# RESETS the staging data (T10g): staging data is disposable. It is never restored from a backup and its volumes are never reused for real data.
# Stops the stack and deletes the database, the filestore and the accounts volumes of the kayas-staging project (not the Caddy volume: certificates
# are kept so that a reset does not use up the CA's rate limits). Then ./scripts/staging/up.sh makes a fresh instance with a new birth marker.
# A typed confirmation is required. The compose project is fixed; no other volume can be named here.
set -euo pipefail
cd "$(dirname "$0")/../.."
project=kayas-staging
echo "This DELETES all staging data (database, documents, seed credentials) of the compose project $project."
if [ "${KAYAS_RESET_CONFIRM:-}" != "RESET-STAGING" ]; then
  [ -t 0 ] || { echo "reset.sh: no terminal: set KAYAS_RESET_CONFIRM=RESET-STAGING to confirm in a script" >&2; exit 1; }
  read -r -p "Type RESET-STAGING to continue: " typed </dev/tty
  [ "$typed" = RESET-STAGING ] || { echo "reset.sh: not confirmed" >&2; exit 1; }
fi
./scripts/staging/dc.sh stop-all
./scripts/staging/dc.sh down --remove-orphans
for v in pgdata filestore accounts; do
  name="${project}_${v}"
  if docker volume inspect "$name" >/dev/null 2>&1; then docker volume rm "$name" >/dev/null; echo "removed volume $name"; fi
done
rm -rf .staging-evidence
echo "reset.sh: done. Start a fresh instance with ./scripts/staging/up.sh"
