#!/usr/bin/env bash
# Deploys an APPROVED RELEASE (T10g, R19B-02, R19B-08). Arguments are the four values of the release: the reviewed commit, the image digest the "Build and
# publish image" workflow printed for it, the platform and the workflow run id (its integration job passed: the image job needs it):
#   ./scripts/ops/deploy.sh <commit 40 hex> ghcr.io/<owner>/kayas@sha256:<digest> linux/amd64 <run id>
#   ./scripts/ops/deploy.sh --recover        after an interrupted or failed deployment (the journal says which)
# One deployment at a time (an exclusive flock that the kernel releases when the process dies). Needs `docker login ghcr.io` once on the server with a read-only
# token (read:packages). The host checkout is moved to the exact approved commit (the branch tip is never followed), the image is pulled by digest and its platform checked, a fresh
# backup is taken with the CURRENT release, the migrations run with the NEW image, the app starts, and success means: the app answers readiness AND the public
# route answers. Every step is written to release/.deploy-journal. Any failure after the switch puts the previous release back and says "rolled back" ONLY
# when the previous app became ready and the public route answered; otherwise it says RECOVERY FAILED and exits 4. The schema is additive, so the previous
# image runs on the migrated database; a rollback of the image is not a rollback of the data (restore, runbook section 5).
set -euo pipefail
cd "$(dirname "$0")/../.."
exec python3 -I scripts/ops/with-lock.py release/.deploy.lock -- bash scripts/ops/deploy-stage.sh "$@"
