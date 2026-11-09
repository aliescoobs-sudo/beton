#!/usr/bin/env bash
# Prints the image reference and the image id the training app and ops containers are RUNNING (R16-03). Only these two fields are read from
# Docker (never the environment, never the whole inspect output). ops is a run-once container: "not running" is normal between maintenance jobs.
set -euo pipefail
cd "$(dirname "$0")/../.."
. ./scripts/training/image-policy.sh
for svc in app ops; do
  id=$(./scripts/training/dc.sh ps -q "$svc" 2>/dev/null | head -n1 || true)
  if [ -z "$id" ]; then echo "$svc: not running"; continue; fi
  line=$(docker inspect --format '{{.Config.Image}} {{.Image}}' "$id")
  ref=${line%% *}
  if kayas_check_image "$ref" "$svc" 2>/dev/null; then verdict="accepted digest"; else verdict="NOT the accepted digest"; fi
  echo "$svc: $line ($verdict)"
done
