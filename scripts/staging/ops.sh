#!/usr/bin/env bash
# Runs one maintenance job of the STAGING stack in the ops container, with plain node, bound to the approved release and RECORDED (T10g, R19B-02, -04).
#   ./scripts/staging/ops.sh db-bootstrap | db-migrate | seed-training | reset-training [args…]
#   ./scripts/staging/ops.sh [--interactive|--batch] <script> …       (a terminal gives the job a TTY: prompts are hidden; --batch reads a supplied stdin)
#   ./scripts/staging/ops.sh --prepare-out     (makes the credentials folder of the ops container: the one job that runs as root, with CHOWN and FOWNER only)
# The image, the commit and the platform come from release/APPROVED (scripts/ops/release-lib.sh); scripts/staging/dc.sh refuses a shell override and validates the
# effective configuration before a container exists. Evidence: .staging-evidence/ops-executions.jsonl (0600). NO host folder is mounted, and none can be asked for.
set -euo pipefail
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
. ./scripts/ops/job-lib.sh
mode=auto
case "${1:-}" in --interactive) mode=interactive; shift ;; --batch) mode=batch; shift ;; esac
job="${1:?usage: ops.sh [--interactive|--batch] <script name without .ts> [args…] | --prepare-out}"
shift
kayas_reject_overrides ops.sh
if [ -n "${OPS_TWIN_DIR+x}" ]; then echo "ops.sh: OPS_TWIN_DIR is not supported on staging (no host folder is mounted)" >&2; exit 1; fi
# the approval (or, in the local rehearsal, the local image) as dc.sh reads it: dc.sh refuses anything else before a container exists
if grep -q -E '^STAGING_REHEARSAL=1$' .env.staging 2>/dev/null; then
  RELEASE_IMAGE="$(sed -n 's/^REHEARSAL_IMAGE=//p' .env.staging | head -n1)"; RELEASE_PLATFORM="$(sed -n 's/^STAGING_PLATFORM=//p' .env.staging | head -n1)"
  RELEASE_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo rehearsal)"
  [[ "$RELEASE_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "ops.sh: the rehearsal image must be a local image id" >&2; exit 1; }
else
  kayas_read_approved ops.sh
  kayas_require_release_checkout ops.sh
fi
JOB_TTY=no
case "$mode" in
  interactive) { [ -t 0 ] && [ -t 2 ]; } || { echo "ops.sh: --interactive needs a terminal" >&2; exit 1; }; JOB_TTY=yes ;;
  auto) { [ -t 0 ] && [ -t 2 ]; } && JOB_TTY=yes ;;
esac
evidence=.staging-evidence/ops-executions.jsonl
if [ "$job" = "--prepare-out" ]; then
  JOB_TTY=no
  kayas_run_job ./scripts/staging/dc.sh "$evidence" prepare-out ops --user root --cap-add CHOWN --cap-add FOWNER -- sh -c 'mkdir -p /app/out && chown 10001:10001 /app/out && chmod 700 /app/out'
else
  [[ "$job" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "ops.sh: the script name must be a plain name (letters, digits, -)" >&2; exit 2; }
  kayas_run_job ./scripts/staging/dc.sh "$evidence" "$job" ops -- node --import ./scripts/register-ts-paths.mjs "scripts/${job}.ts" "$@"
fi
