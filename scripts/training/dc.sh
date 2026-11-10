#!/usr/bin/env bash
# The ONE way to run docker compose for the training instance: it passes both env files, so that compose can read the file from any shell.
#
# R17-01: the image that is VALIDATED is the image that RUNS. Compose takes a shell variable over an env file, and a later env file over an
# earlier one, so this wrapper (1) refuses every way to change the configuration from outside (an APP_IMAGE in the shell, one in the second env
# file, a duplicated key, an extra -f / --env-file / project option before the subcommand, COMPOSE_* variables are dropped), (2) validates the value
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
# global options that change which files or project compose reads: only before the subcommand (what follows it belongs to the command)
for arg in "$@"; do
  case "$arg" in
    -f|--file|-f?*|--file=*|--env-file|--env-file=*|-p|--project-name|-p?*|--project-name=*|--project-directory|--project-directory=*|--profile|--profile=*)
      echo "training dc.sh: the compose option '${arg%%=*}' is refused: the configuration is fixed by this script." >&2; exit 1 ;;
    -*) ;;
    *) break ;;
  esac
done

# 2. the value
image="$(sed -n 's/^APP_IMAGE=//p' .env.training)"
kayas_check_image "$image" "training dc.sh" || exit 1

compose() {
  env -u COMPOSE_FILE -u COMPOSE_ENV_FILES -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES -u COMPOSE_PATH_SEPARATOR -u COMPOSE_PARALLEL_LIMIT \
    APP_IMAGE="$image" docker compose -f docker-compose.training.yml --env-file .env.training --env-file .env.training.ops "$@"
}

# 4. what compose RESOLVED (image names only): the application and ops images are the validated one, the others are the pinned third-party images
resolved="$(compose config --images)" || { echo "training dc.sh: could not resolve the compose images; nothing was run." >&2; exit 1; }
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    ghcr.io/*) [ "$line" = "$image" ] || { echo "training dc.sh: compose resolved an application image that is not the validated one. Refused." >&2; exit 1; } ;;
    postgres:*@sha256:*|caddy:2-alpine) ;;
    *) echo "training dc.sh: compose resolved an unexpected image '${line%%@*}'. Refused." >&2; exit 1 ;;
  esac
done <<<"$resolved"

# 3. the validated value is what runs
exec env -u COMPOSE_FILE -u COMPOSE_ENV_FILES -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES -u COMPOSE_PATH_SEPARATOR -u COMPOSE_PARALLEL_LIMIT \
  APP_IMAGE="$image" docker compose -f docker-compose.training.yml --env-file .env.training --env-file .env.training.ops "$@"
