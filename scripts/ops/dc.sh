#!/usr/bin/env bash
# The ONE way to run docker compose on the PRODUCTION server (C2, CODEX-REVIEW-R9 item 4; T10g, R19B-02). It passes --env-file .env.ops.prod, and it binds
# every command to the APPROVED RELEASE (release/APPROVED, see scripts/ops/release-lib.sh):
#   1. nothing exported in the shell may change what runs: APP_IMAGE, COMPOSE_*, DOCKER_HOST... are refused (not scrubbed);
#   2. no env file may carry an APP_IMAGE; the image comes from release/APPROVED (digest only, the one registry/owner/package, linux/amd64);
#   3. the host files (this script, the compose file, the Caddyfile) are at the approved commit and no tracked file was edited;
#   4. the sub-command is allow-listed and comes first; `run` and `exec` options are allow-listed (no -v, -e, --entrypoint, --privileged...);
#   5. what compose RESOLVED is checked (scripts/ops/validate-compose.py: images of app/ops/bootstrap/backup are the approved digest, ports, mounts,
#      capabilities, hardening) BEFORE anything is created. A refusal happens before any credential reaches a container.
#   ./scripts/ops/dc.sh up -d --wait db
#   ./scripts/ops/dc.sh run --rm -T ops node --import ./scripts/register-ts-paths.mjs scripts/db-migrate.ts
set -euo pipefail
cd "$(dirname "$0")/../.."
. ./scripts/ops/release-lib.sh
kayas_reject_overrides dc.sh
[ -r .env.ops.prod ] || { echo "dc.sh: .env.ops.prod not found or not readable in $(pwd)" >&2; exit 1; }
kayas_reject_env_file_image dc.sh .env.prod .env.ops.prod .env.backup.prod .env.bootstrap.prod
kayas_read_approved dc.sh
kayas_require_release_checkout dc.sh
sub="${1:-}"
case "$sub" in
  config|pull|run|up|stop|exec|ps|logs|down|restart) ;;
  '') echo "dc.sh: a sub-command is required (config, pull, run, up, stop, exec, ps, logs, down, restart)." >&2; exit 1 ;;
  *) echo "dc.sh: '${sub%%=*}' is not an allowed first argument: only config, pull, run, up, stop, exec, ps, logs, down and restart, and no compose option before the sub-command." >&2; exit 1 ;;
esac
shift
case "$sub" in
  run|exec) kayas_check_run_args prod "$sub" "$@" || exit 1 ;;
  down) for a in "$@"; do case "$a" in -v|--volumes|--rmi*) echo "dc.sh: down with $a is refused (it would delete the database or the documents)." >&2; exit 1 ;; esac; done ;;
esac
base=(env APP_IMAGE="$RELEASE_IMAGE" docker compose -f docker-compose.prod.yml --env-file .env.ops.prod)
kayas_validate_effective dc.sh prod "${base[@]}" --profile ops --profile bootstrap config --format json
exec "${base[@]}" "$sub" "$@"
