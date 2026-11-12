#!/usr/bin/env bash
# Runs one maintenance script in the ops container with plain node: no pnpm, no corepack, no network (the ops container is on an internal network and
# cannot download anything; CODEX-REVIEW-R9 item 10). T10g (R19B-02, -04): the job is bound to the APPROVED release (release/APPROVED: commit, digest,
# platform), recorded in release/evidence/jobs.jsonl with the actual image id, and refused before any credential reaches a container when the host files,
# the image or the effective configuration are not the approved ones.
#   ./scripts/ops/ops.sh db-migrate
#   ./scripts/ops/ops.sh create-owner                 (a terminal: the password and the code are typed at HIDDEN prompts)
#   ./scripts/ops/ops.sh --batch create-owner < file  (no terminal: the answers come from a securely supplied stdin; nothing is echoed)
#   ./scripts/ops/ops.sh import-excel --dry-run imports/book.xlsx --mapping imports/mapping
set -euo pipefail
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
. ./scripts/ops/job-lib.sh
mode=auto
case "${1:-}" in --interactive) mode=interactive; shift ;; --batch) mode=batch; shift ;; esac
script="${1:?usage: ops.sh [--interactive|--batch] <script name without .ts> [args…]}"
shift
[[ "$script" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "ops.sh: the script name must be a plain name (letters, digits, -)" >&2; exit 2; }
kayas_reject_overrides ops.sh
kayas_read_approved ops.sh
kayas_require_release_checkout ops.sh
# R19B-04: with a terminal on stdin the container gets a TTY and the prompts of the scripts read hidden input; without one (--batch, a pipe) stdin is passed
# as it is and nothing is echoed back. --interactive without a terminal is refused rather than silently reading a secret in clear.
JOB_TTY=no
case "$mode" in
  interactive) { [ -t 0 ] && [ -t 2 ]; } || { echo "ops.sh: --interactive needs a terminal" >&2; exit 1; }; JOB_TTY=yes ;;
  auto) { [ -t 0 ] && [ -t 2 ]; } && JOB_TTY=yes ;;
esac
kayas_run_job ./scripts/ops/dc.sh release/evidence/jobs.jsonl "$script" ops -- node --import ./scripts/register-ts-paths.mjs "scripts/${script}.ts" "$@"
