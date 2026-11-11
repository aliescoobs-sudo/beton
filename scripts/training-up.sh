#!/usr/bin/env bash
# Starts the training instance (T1) on this machine, and prepares it on the first run: image, database, roles, structure, training data.
# Safe to run again (an already seeded database is left alone). Prints what to do next by hand.
#   ./scripts/training-up.sh
set -euo pipefail
cd "$(dirname "$0")/.."
dc=./scripts/training/dc.sh
ops=./scripts/training/ops.sh
for f in .env.training .env.training.ops; do
  [ -r "$f" ] || { echo "training-up.sh: $f is missing. First run:  APP_IMAGE=ghcr.io/<owner>/kayas@sha256:<digest> ./scripts/training/init-env.sh" >&2; exit 1; }
done
# R17-01: the image is the one in .env.training only; an APP_IMAGE exported in this shell would win over the file inside compose.
if [ -n "${APP_IMAGE+x}" ]; then
  echo "training-up.sh: APP_IMAGE is set in the shell. Refused: the image comes from .env.training only (unset APP_IMAGE and run again)." >&2; exit 1
fi
# R16-03: the image in the env file must be the accepted digest BEFORE any pull, bootstrap or seed (a tag left in an old file is refused).
. ./scripts/training/image-policy.sh
configured=$(sed -n 's/^APP_IMAGE=//p' .env.training | head -n1)
kayas_require_image "$configured" training-up.sh
docker info >/dev/null 2>&1 || { echo "training-up.sh: Docker does not answer. On the iMac start it first:  colima start --arch x86_64 --cpu 2 --memory 4 --disk 40" >&2; exit 1; }
# R16-04: the rename to KAYAS changed the compose project (belgobeton-training -> kayas-training), so the volumes and the published port of an
# old stack are NOT this stack's: starting now would silently create a second, empty stack next to it (or fail on the port). Stop and say so.
# Retire the old stack explicitly first (docs/checkpoints/CP-TRAINING.md, "Upgrading a pre-KAYAS training install"); nothing is removed here.
old_project=belgobeton-training
# R17-10: the port and the project are those of the EFFECTIVE compose configuration (the file's own APP_PORT and name), read as two narrow
# fields from `config`; nothing else of it is kept or printed (it holds secrets). If they cannot be read the start is refused.
cfg=$($dc config) || { echo "training-up.sh: could not read the effective compose configuration; nothing was started." >&2; exit 1; }
new_project=$(printf '%s\n' "$cfg" | sed -n 's/^name: *//p' | head -n1 | tr -d '"')
port=$(printf '%s\n' "$cfg" | awk '/^  app:/{f=1;next} /^  [a-z]/{f=0} f && /published:/{v=$NF; gsub(/"/,"",v); print v; exit}')
unset cfg
case "$new_project" in ''|*[!a-z0-9_-]*) echo "training-up.sh: could not read the compose project name; nothing was started." >&2; exit 1;; esac
case "$port" in ''|*[!0-9]*) echo "training-up.sh: could not read the published port of the app from the compose configuration; nothing was started." >&2; exit 1;; esac
# Every inventory must SUCCEED: a docker that fails to answer is not an empty answer ("absent").
inventory() { out=$("$@") || { echo "training-up.sh: the docker inventory ($2 $3) failed; this is not an empty answer. Nothing was started." >&2; exit 1; }; printf '%s' "$out"; }
old_containers=$(inventory docker ps -a -q --filter "label=com.docker.compose.project=$old_project")
old_volumes=$(inventory docker volume ls -q --filter "label=com.docker.compose.project=$old_project")
if [ -n "$old_containers" ] || [ -n "$old_volumes" ]; then
  echo "training-up.sh: a pre-KAYAS training stack ($old_project) still exists on this machine (containers or volumes). Starting would create a second, empty stack. Retire it explicitly first: see 'Upgrading a pre-KAYAS training install' in docs/checkpoints/CP-TRAINING.md (remove its volumes after the archive, or keep nothing of them). Nothing was started or removed." >&2
  exit 1
fi
holders=$(inventory docker ps --filter "publish=$port" --format '{{.Names}}|{{.Label "com.docker.compose.project"}}')
while IFS= read -r holder; do
  [ -z "$holder" ] && continue
  case "$holder" in
    *"|$new_project") ;;
    *) echo "training-up.sh: port $port is already published by another container (${holder%%|*}), which is not the $new_project stack. Stop it first (see 'Upgrading a pre-KAYAS training install' in docs/checkpoints/CP-TRAINING.md). Nothing was started." >&2; exit 1 ;;
  esac
done <<<"$holders"
$dc pull
# R11-04: the credentials file lives in a Docker volume ("accounts"), not in a folder of this checkout that other users of the machine could
# reach: the folder is made owned by the container user (10001) and closed to everybody else (0700) before the seed writes into it.
$ops --prepare-out
$dc up -d --wait db
$ops db-bootstrap
$ops db-migrate
$ops seed-training
$dc up -d app
# R11: the instance is only called up once it answers its readiness check (database reachable, migrations applied).
ready=no
for _ in $(seq 1 "${READY_TRIES:-30}"); do
  if $dc exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready 2>/dev/null | grep -q '"ready"'; then ready=yes; break; fi
  sleep "${READY_SLEEP:-5}"
done
[ "$ready" = yes ] || { echo "training-up.sh: the app did not become ready: look at  ./scripts/training/dc.sh logs app" >&2; exit 1; }
# R15A-06: LOCAL ONLY. The instance is not published and there is no public helper any more. This script does NOT look for a tunnel or any
# other publisher and says nothing about one: keeping the Mac free of them is the operator's responsibility (docs/checkpoints/CP-TRAINING.md, step 8).
cat <<'NEXT'

The training instance is running and answered its readiness check, on this Mac:  http://127.0.0.1:3000   (http://localhost:3000 after  ./scripts/training/set-url.sh http://localhost:3000)

This start-up does not check whether anything publishes this Mac to a network or to the internet. The operator is responsible for there being no
tunnel, proxy or port forward (CP-TRAINING.md, step 8). Nothing printed here is evidence that the instance is local-only.

Next, by hand:
  1. Hand each trainee ONLY their own account (never the whole list):   ./scripts/training/show-accounts.sh <name>
  2. One browser profile per training identity; never hand a phone over by signing out and in again in the same page; if something is stuck, stop that exercise.
  3. Stop everything with  ./scripts/training-down.sh
NEXT
