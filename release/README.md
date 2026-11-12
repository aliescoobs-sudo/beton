# release/

Host-local release state (T10g, R19B-02/-08). Only this README is in git.

- `APPROVED` — the approved release of this host: `COMMIT`, `IMAGE` (digest), `PLATFORM`, `RUN_ID`. Written by `scripts/ops/approve-release.sh` (first install) and by `scripts/ops/deploy.sh`. Never edited by hand. No wrapper starts a container without it.
- `APPROVED.previous` — the release before the last deployment (the rollback target).
- `.deploy-journal` — one JSON line per deployment state (`begin`, `pulled`, `backup_ok`, `switched`, `migrated`, `started`, `ready`, `done`, `rollback_started`, `rollback_verified`, `ROLLBACK_FAILED`, `recovered`).
- `.deploy.lock` — the deployment lock (`flock`, released by the kernel when the process dies).
- `evidence/jobs.jsonl` — one start and one end line for every privileged job: the approved digest next to the actual image id. No secret.
