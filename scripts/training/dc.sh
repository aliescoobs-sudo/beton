#!/usr/bin/env bash
# The ONE way to run docker compose for the training instance: it passes both env files, so that compose can read the file from any shell.
#
# R17-01: the image that is VALIDATED is the image that RUNS. Compose takes a shell variable over an env file, and a later env file over an
# earlier one, so this wrapper (1) refuses every way to change the configuration from outside (an APP_IMAGE in the shell, one in the second env
# file, a duplicated key, ANY option before the sub-command (R18-10: the sub-command is allow-listed and comes first), COMPOSE_* variables are dropped), (2) validates the value
# in .env.training, (3) PASSES that exact value to compose explicitly, and (4) asks compose for the images it resolved (names only, never the
# environment) and refuses anything but that value for the application and the ops containers. Nothing here prints an environment.
set -euo pipefail
cd "$(dirname "$0")/../.."
for f in .env.training .env.training.ops; do [ -r "$f" ] || { echo "training dc.sh: $f not found: run ./scripts/training/init-env.sh first" >&2; exit 1; }; done
. ./scripts/training/image-policy.sh

# 1. outside overrides
if [ -n "${APP_IMAGE+x}" ]; then
  echo "training dc.sh: APP_IMAGE is set in the shell. Refused: the image comes from .env.training only (unset APP_IMAGE and run again)." >&2; exit 1
fi
if [ "$(grep -c '^APP_IMAGE=' .env.training)" != 1 ]; then
  echo "training dc.sh: .env.training must contain APP_IMAGE exactly once." >&2; exit 1
fi
if grep -q -E '^[[:space:]]*(export[[:space:]]+)?APP_IMAGE[[:space:]]*=' .env.training.ops; then
  echo "training dc.sh: .env.training.ops sets APP_IMAGE, which would override the validated one. Refused." >&2; exit 1
fi
# R18-10: a STRICT command line. The first argument must be one of the sub-commands the training scripts really use, and NOTHING may come
# before it: a value-taking global option (`--ansi never`, `-p x`, `--env-file f`) used to hide a later `-f override.yml` from a scan that stopped
# at the first word without a dash, so the check and the command saw different arguments. Now there are no global options at all; the
# configuration (files, env files, project, profiles) is built only below. `stop-all` and `up-public` are the two composed commands (stop the profiled services too; start with the public proxy).
sub="${1:-}"
case "$sub" in
  config|pull|run|up|stop|exec|ps|logs|stop-all|up-public) ;;
  '') echo "training dc.sh: a sub-command is required (config, pull, run, up, stop, exec, ps, logs, stop-all, up-public)." >&2; exit 1 ;;
  *) echo "training dc.sh: '${sub%%=*}' is not an allowed first argument: only config, pull, run, up, stop, exec, ps, logs, stop-all and up-public, and no compose option before the sub-command (the configuration is fixed by this script)." >&2; exit 1 ;;
esac
shift
args=("$sub" "$@")
if [ "$sub" = stop-all ]; then args=(--profile public --profile ops stop "$@"); fi
if [ "$sub" = up-public ]; then args=(--profile public up -d "$@"); fi

# 2. the value
image="$(sed -n 's/^APP_IMAGE=//p' .env.training)"
kayas_check_image "$image" "training dc.sh" || exit 1

# the ONE command line: the check below and the final exec use exactly this configuration (files, env files, validated APP_IMAGE, scrubbed COMPOSE_*)
base=(env -u COMPOSE_FILE -u COMPOSE_ENV_FILES -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES -u COMPOSE_PATH_SEPARATOR -u COMPOSE_PARALLEL_LIMIT
  APP_IMAGE="$image" docker compose -f docker-compose.training.yml --env-file .env.training --env-file .env.training.ops)

# 4. what compose RESOLVED, service by service, with every profile enabled (so ops and the proxy are in it): the application and ops images are
# exactly the validated one and BOTH must be present; the database and the proxy are the pinned third-party images; any other service is refused.
# Only the service names and their image lines are kept; the configuration (it holds secrets) is never printed.
resolved="$("${base[@]}" --profile public --profile ops config)" || { echo "training dc.sh: could not resolve the compose configuration; nothing was run." >&2; exit 1; }
pairs="$(printf '%s\n' "$resolved" | awk '/^services:/{s=1;next} /^[^ ]/{s=0} s && /^  [A-Za-z0-9_-]+:/{svc=$1; sub(/:$/,"",svc); seen[svc]=1; order[++n]=svc} s && /^    image:/{img=$2; gsub(/"/,"",img); image[svc]=img} END{for(i=1;i<=n;i++) print order[i] "=" image[order[i]]}')"
unset resolved
have_app=no; have_ops=no
while IFS= read -r line; do
  [ -z "$line" ] && continue
  svc="${line%%=*}"; img="${line#*=}"
  case "$svc" in
    app) have_app=yes; [ "$img" = "$image" ] || { echo "training dc.sh: compose resolved an application image for 'app' that is not the validated one. Refused." >&2; exit 1; } ;;
    ops) have_ops=yes; [ "$img" = "$image" ] || { echo "training dc.sh: compose resolved an image for 'ops' (maintenance credentials) that is not the validated one. Refused." >&2; exit 1; } ;;
    db) case "$img" in postgres:*@sha256:*) ;; *) echo "training dc.sh: compose resolved an unexpected image for 'db'. Refused." >&2; exit 1 ;; esac ;;
    proxy) [ "$img" = "caddy:2-alpine" ] || { echo "training dc.sh: compose resolved an unexpected image for 'proxy'. Refused." >&2; exit 1; } ;;
    *) echo "training dc.sh: compose resolved an unexpected service '$svc'. Refused." >&2; exit 1 ;;
  esac
done <<<"$pairs"
[ "$have_app" = yes ] && [ "$have_ops" = yes ] || { echo "training dc.sh: compose did not resolve both the app and the ops service; nothing was run." >&2; exit 1; }

# 3. the validated value, the checked configuration and the allowed sub-command are what runs
exec "${base[@]}" "${args[@]}"
