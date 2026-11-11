#!/usr/bin/env bash
# Runs one maintenance job of the training instance in the ops container, with plain node, and RECORDS what ran (R18-11).
#   ./scripts/training/ops.sh db-bootstrap | db-migrate | seed-training | reset-training | rearm-training [args…]
#   ./scripts/training/ops.sh --prepare-out        (makes the credentials folder of the ops container: the one job that runs as root)
#   OPS_TWIN_DIR=$HOME/KAYAS-twin ./scripts/training/ops.sh import-history --dry-run /twin/tetouan --mapping /twin/mapping/deliveries-tetouan.json
#     (T11b: the fictitious twin folder, made by `pnpm import:twin`, is mounted READ-ONLY at /twin; nothing else of the host is reachable)
# R17-01: the image check (a shell APP_IMAGE, a second env file's APP_IMAGE, extra compose options, the images compose resolves for app AND ops)
# is made by dc.sh on every call, so the privileged ops container can only run the validated digest.
# R18-11: the ops container is run-once and removed, so after the job nothing showed which image it had been. This wrapper runs it UNDER A NAME
# (no --rm), reads what the container really was (its image reference, its image id, the platform of that image, the exit code), and only then
# removes it. One JSON line for the start and one for the end go to .training-evidence/ops-executions.jsonl (mode 0600, git- and image-ignored):
# the approved commit / digest / platform of .env.training next to the ACTUAL ones. A mismatch is a failure of this script, whatever the job did.
set -euo pipefail
cd "$(dirname "$0")/../.."
dc=./scripts/training/dc.sh
mode="${1:?usage: ops.sh <script name without .ts> [args…] | --prepare-out}"
shift
# the image of the env file must be the accepted digest BEFORE anything is recorded or started (R16-03): a refused reference reaches no docker call
. ./scripts/training/image-policy.sh
kayas_check_image "$(sed -n 's/^APP_IMAGE=//p' .env.training | head -n1)" ops.sh || exit 1

approved_image="$(sed -n 's/^APP_IMAGE=//p' .env.training | head -n1)"
approved_commit="$(sed -n 's/^APP_COMMIT=//p' .env.training | head -n1)"
approved_platform="$(sed -n 's/^APP_PLATFORM=//p' .env.training | head -n1)"
evidence_dir=.training-evidence
evidence="$evidence_dir/ops-executions.jsonl"
umask 077
mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
[ -L "$evidence" ] && { echo "ops.sh: $evidence is a link: refused" >&2; exit 1; }

# json <key> <value>…: values are image references, ids, platforms, job names and numbers (no quote or backslash can occur); anything else is refused
line() {
  local out="{" first=1 k v
  while [ "$#" -ge 2 ]; do
    k=$1 v=$2; shift 2
    case "$v" in *[!A-Za-z0-9:@._/=+,\ -]*) echo "ops.sh: refusing to record a value with unexpected characters ($k)" >&2; return 1 ;; esac
    [ "$first" = 1 ] || out+=","
    first=0
    out+="\"$k\":\"$v\""
  done
  printf '%s}\n' "$out"
}
record() { line "$@" >> "$evidence" || { echo "ops.sh: could not write the execution evidence: the job was not run (or its record is incomplete)" >&2; return 1; }; }

# T11b: an optional read-only mount of the twin folder (an absolute path to an existing directory; the twin holds fictitious files only)
mount=()
if [ -n "${OPS_TWIN_DIR:-}" ]; then
  case "$OPS_TWIN_DIR" in /*) ;; *) echo "ops.sh: OPS_TWIN_DIR must be an absolute path" >&2; exit 1 ;; esac
  case "$OPS_TWIN_DIR" in *[!A-Za-z0-9._/-]*) echo "ops.sh: OPS_TWIN_DIR has unexpected characters" >&2; exit 1 ;; esac
  [ -d "$OPS_TWIN_DIR" ] || { echo "ops.sh: OPS_TWIN_DIR is not a directory" >&2; exit 1; }
  mount=(-v "$OPS_TWIN_DIR:/twin:ro")
fi
job="$mode"
[ "$mode" = "--prepare-out" ] && job="prepare-out"
name="kayas-ops-$(date -u +%Y%m%dT%H%M%SZ)-$$"
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record event start at "$at" job "$job" container "$name" approved_commit "${approved_commit:-unrecorded}" approved_digest "${approved_image##*@}" approved_platform "${approved_platform:-unrecorded}"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
started=no

rc=0
trap '[ "$started" = yes ] && cleanup' EXIT
started=yes
if [ "$mode" = "--prepare-out" ]; then
  "$dc" run --name "$name" -T --user root ops sh -c 'mkdir -p /app/out && chown 10001:10001 /app/out && chmod 700 /app/out' || rc=$?
else
  "$dc" run --name "$name" -T ${mount[@]+"${mount[@]}"} ops node --import ./scripts/register-ts-paths.mjs "scripts/${mode}.ts" "$@" || rc=$?
fi

# what the finished container really was (a failed query is a failure, never "unknown but fine")
actual="$(docker inspect --format '{{.Config.Image}}|{{.Image}}|{{.State.ExitCode}}' "$name" 2>/dev/null || true)"
actual_ref="${actual%%|*}"; rest="${actual#*|}"; actual_id="${rest%%|*}"; actual_exit="${rest##*|}"
actual_platform=""
[ -n "$actual_id" ] && actual_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$actual_id" 2>/dev/null || true)"
verdict=match
reason=""
if [ -z "$actual_ref" ] || [ -z "$actual_id" ] || [ -z "$actual_platform" ]; then verdict=unproven; reason="the container could not be inspected"
elif [ "$actual_ref" != "$approved_image" ]; then verdict=MISMATCH; reason="the container ran another image than the approved digest"
elif [ -n "$approved_platform" ] && [ "$actual_platform" != "$approved_platform" ]; then verdict=MISMATCH; reason="the image platform is not the approved one"
fi
record event end at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" job "$job" container "$name" exit "$rc" container_exit "${actual_exit:-unknown}" actual_digest "${actual_ref##*@}" actual_image_id "${actual_id:-unknown}" actual_platform "${actual_platform:-unknown}" verdict "$verdict" || verdict=unrecorded
if [ "$verdict" != match ]; then
  echo "ops.sh: the execution evidence of '$job' is '$verdict'${reason:+ ($reason)}: see $evidence. Treat the job as NOT verified." >&2
  [ "$rc" -ne 0 ] && exit "$rc"
  exit 3
fi
exit "$rc"
