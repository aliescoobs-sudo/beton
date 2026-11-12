#!/usr/bin/env bash
# Phase 2 of a deployment (T10g), run from the NEW tree (or, with --recover, from whatever tree is checked out): migrate, start, verify, and put the previous
# release back when anything fails, VERIFYING the recovery. Exit codes: 0 deployed; 1 failed and rolled back (verified); 4 failed and the recovery failed.
set -uo pipefail
umask 027
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
. ./scripts/ops/deploy-lib.sh
tries="${READY_TRIES:-30}"; nap="${READY_SLEEP:-5}"
[[ "$tries" =~ ^[0-9]{1,3}$ && "$nap" =~ ^[0-9]{1,3}$ ]] || { echo "deploy.sh: READY_TRIES and READY_SLEEP must be whole numbers" >&2; exit 2; }

domain="$(sed -n 's/^APP_DOMAIN=//p' .env.ops.prod | head -n1)"
public_url="https://${domain}/fr/login"
app_ready() { ./scripts/ops/dc.sh exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready 2>/dev/null | grep -q '"ready"'; }
public_ok() { [ -n "$domain" ] && command -v curl >/dev/null && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$public_url" 2>/dev/null)" = 200 ]; }
wait_ready() { # app readiness AND the public route
  local i
  for i in $(seq 1 "$tries"); do
    if app_ready && public_ok; then return 0; fi
    sleep "$nap"
  done
  return 1
}

rollback() {
  local why="$1"
  echo "deploy.sh: FAILED: $why" >&2
  kayas_journal rollback_started "$why"
  if [ ! -f release/APPROVED.previous ]; then
    kayas_journal ROLLBACK_FAILED "there is no previous release"
    echo "deploy.sh: RECOVERY FAILED: there was no previous release to go back to. The service is not running a verified release." >&2
    exit 4
  fi
  kayas_read_approved deploy.sh release/APPROVED.previous || { kayas_journal ROLLBACK_FAILED "the previous approval is unreadable"; echo "deploy.sh: RECOVERY FAILED: the previous approval is unreadable." >&2; exit 4; }
  local pc="$RELEASE_COMMIT" pi="$RELEASE_IMAGE" pp="$RELEASE_PLATFORM" pr="$RELEASE_RUN_ID"
  kayas_write_approved "$pc" "$pi" "$pp" "$pr"
  # a deployment killed while git held its index lock leaves a stale lock; no git process of ours runs now (we hold the deploy lock), so it is safe to clear it once
  if [ -e .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1; then rm -f .git/index.lock; fi
  if ! git checkout --detach --quiet "$pc"; then
    kayas_journal ROLLBACK_FAILED "the previous commit could not be checked out"
    echo "deploy.sh: RECOVERY FAILED: the host files could not be put back at ${pc:0:12}. Start the previous release by hand." >&2; exit 4
  fi
  if ! ./scripts/ops/dc.sh up -d app proxy >&2; then
    kayas_journal ROLLBACK_FAILED "the previous release did not start"
    echo "deploy.sh: RECOVERY FAILED: the previous release (${pi##*@}) did not start. The service is DOWN." >&2; exit 4
  fi
  if wait_ready; then
    kayas_journal rollback_verified "$pc ${pi##*@}"
    echo "deploy.sh: rolled back to ${pc:0:12} (${pi##*@}) and VERIFIED: the app is ready and the public route answers." >&2
    exit 1
  fi
  kayas_journal ROLLBACK_FAILED "the previous release started but did not become ready, or the public route does not answer"
  echo "deploy.sh: RECOVERY FAILED: the previous release started but the app is not ready or the public route does not answer. The service is DEGRADED or DOWN." >&2
  exit 4
}

if [ "${1:-}" = --recover ]; then
  kayas_journal_last
  case "$LAST_STATE" in
    begin|pulled|backup_ok|failed_before_switch|refused) kayas_journal recovered "interrupted before the switch; the running release was not changed"
      if app_ready && public_ok; then echo "deploy.sh: recovered: nothing had been switched and the current release is serving." >&2; exit 0; fi
      echo "deploy.sh: nothing had been switched, but the current release is NOT serving (app ready or public route failed). Look at the logs." >&2; exit 4 ;;
    *) rollback "recovery after an interrupted deployment (state $LAST_STATE)" ;;
  esac
fi

kayas_read_approved deploy.sh || exit 1
kayas_require_release_checkout deploy.sh || { rollback "the host is not at the approved commit after the switch"; }
trap 'rollback "the deployment was interrupted by a signal"' INT TERM HUP
./scripts/ops/ops.sh --batch db-migrate </dev/null >&2 || rollback "the migrations failed"
kayas_journal migrated ""
./scripts/ops/dc.sh up -d app proxy >&2 || rollback "the new release did not start"
kayas_journal started ""
wait_ready || rollback "the new release did not become ready, or the public route does not answer"
kayas_journal ready ""
trap - INT TERM HUP
kayas_journal done "${RELEASE_COMMIT} ${RELEASE_IMAGE##*@}"
echo "deployed ${RELEASE_COMMIT:0:12} ${RELEASE_IMAGE##*@}: app ready and public route answers."
