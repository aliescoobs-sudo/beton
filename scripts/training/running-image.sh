#!/usr/bin/env bash
# Prints, for every training app and ops container that is RUNNING, the image reference and image id it runs, and compares them with the
# CONFIGURED digest (R16-03, R17-01/10). Only two fields are read from Docker (never the environment, never the whole inspect output).
# "mismatch" is a verdict, not a refusal of a digest shape. A failed query is reported as a failure (exit 2), never as "not running". ops is a
# run-once container: "not running" is normal between maintenance jobs, and it leaves no evidence here of the image of an earlier job.
set -euo pipefail
cd "$(dirname "$0")/../.."
. ./scripts/training/image-policy.sh
configured="$(sed -n 's/^APP_IMAGE=//p' .env.training | head -n1)"
kayas_check_image "$configured" running-image.sh || exit 1
status=0
for svc in app ops; do
  ids="$(./scripts/training/dc.sh ps -q "$svc")" || { echo "$svc: QUERY FAILED (docker or the image check did not answer): this is not 'not running'" >&2; status=2; continue; }
  if [ -z "$ids" ]; then echo "$svc: not running"; continue; fi
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    line="$(docker inspect --format '{{.Config.Image}} {{.Image}}' "$id")" || { echo "$svc: QUERY FAILED for a container" >&2; status=2; continue; }
    ref=${line%% *}
    if [ "$ref" = "$configured" ]; then verdict="matches the configured digest"; else verdict="MISMATCH: not the configured digest"; status=${status/#0/1}; fi
    echo "$svc: $line ($verdict)"
  done <<<"$ids"
done
exit "$status"
