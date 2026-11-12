#!/usr/bin/env bash
# Runs ONE privileged job in a container and RECORDS what ran (T10g, R19B-02; the same evidence as the training wrapper, R18-11). Sourced; defines functions only.
# Needs RELEASE_COMMIT / RELEASE_IMAGE / RELEASE_PLATFORM (kayas_read_approved) and a compose wrapper that has already validated the effective configuration.
#
# kayas_run_job <dc-wrapper> <evidence-file> <job-name> <service> [compose run options…] -- <command…>
# The container is run UNDER A NAME (no --rm), then inspected (its image reference, image id, the platform of that image, the exit code), then removed. One JSON
# line for the start and one for the end go to the evidence file (mode 0600 in a 0700 directory): the approved commit and digest next to the ACTUAL image id.
# A mismatch or an unprovable container is a failure of this function (exit 3) whatever the job did. No value of any environment is read or recorded.
kayas_evidence_line() {
  local out="{" first=1 k v
  while [ "$#" -ge 2 ]; do
    k=$1 v=$2; shift 2
    case "$v" in *[!A-Za-z0-9:@._/=+,\ -]*) echo "job-lib: refusing to record a value with unexpected characters ($k)" >&2; return 1 ;; esac
    [ "$first" = 1 ] || out+=","
    first=0
    out+="\"$k\":\"$v\""
  done
  printf '%s}\n' "$out"
}

kayas_run_job() {
  local dc="$1" evidence="$2" job="$3" service="$4"; shift 4
  local opts=() cmd=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do opts+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  cmd=("$@")
  [ "${#cmd[@]}" -gt 0 ] || { echo "job-lib: no command" >&2; return 2; }
  local dir; dir="$(dirname "$evidence")"
  ( umask 077; mkdir -p "$dir" ) && chmod 700 "$dir"
  [ ! -L "$evidence" ] || { echo "job-lib: $evidence is a link: refused" >&2; return 1; }
  local name="kayas-job-$(date -u +%Y%m%dT%H%M%SZ)-$$" at line
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  line="$(kayas_evidence_line event start at "$at" job "$job" service "$service" container "$name" approved_commit "$RELEASE_COMMIT" approved_digest "${RELEASE_IMAGE##*@}" approved_platform "$RELEASE_PLATFORM")" || return 1
  ( umask 077; printf '%s\n' "$line" >> "$evidence" ) || { echo "job-lib: could not write the execution evidence: the job was NOT run" >&2; return 1; }
  local rc=0
  # JOB_TTY is assigned by the calling wrapper (never read from the environment): "yes" gives the container a TTY (hidden prompts), otherwise -T.
  local tty_flag=(-T)
  [ "${JOB_TTY:-no}" = yes ] && tty_flag=()
  "$dc" run --name "$name" ${tty_flag[@]+"${tty_flag[@]}"} ${opts[@]+"${opts[@]}"} "$service" "${cmd[@]}" || rc=$?
  local actual actual_ref rest actual_id actual_exit actual_platform="" verdict=match reason=""
  actual="$(docker inspect --format '{{.Config.Image}}|{{.Image}}|{{.State.ExitCode}}' "$name" 2>/dev/null || true)"
  actual_ref="${actual%%|*}"; rest="${actual#*|}"; actual_id="${rest%%|*}"; actual_exit="${rest##*|}"
  [ -n "$actual_id" ] && actual_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$actual_id" 2>/dev/null || true)"
  if [ -z "$actual_ref" ] || [ -z "$actual_id" ] || [ -z "$actual_platform" ]; then verdict=unproven; reason="the container could not be inspected"
  elif [ "$actual_ref" != "$RELEASE_IMAGE" ]; then verdict=MISMATCH; reason="the container ran another image than the approved digest"
  elif [ "$actual_platform" != "$RELEASE_PLATFORM" ]; then verdict=MISMATCH; reason="the image platform is not the approved one"
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  line="$(kayas_evidence_line event end at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" job "$job" service "$service" container "$name" exit "$rc" container_exit "${actual_exit:-unknown}" \
    actual_digest "${actual_ref##*@}" actual_image_id "${actual_id:-unknown}" actual_platform "${actual_platform:-unknown}" verdict "$verdict")" || line=""
  [ -n "$line" ] || line='{"event":"end","verdict":"unrecordable"}'
  ( umask 077; printf '%s\n' "$line" >> "$evidence" ) || true
  if [ "$verdict" != match ]; then
    echo "job-lib: the execution evidence of '$job' is '$verdict'${reason:+ ($reason)}: see $evidence. Treat the job as NOT verified." >&2
    [ "$rc" -ne 0 ] && return "$rc"
    return 3
  fi
  return "$rc"
}
