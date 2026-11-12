# R20 response (T10h, 12 Nov 2026)

Answers `docs/reviews/CODEX-REVIEW-R20.md` (target `4191ccc`). Verdict received: **GO for a fresh, fictitious-data staging instance; real data NO-GO; G1–G12 stay OPEN.** No blocking finding. This round changes only what the task listed: the staging guide, the image filter, the effective proxy-input validation and the gate wording. Nothing was deployed, nothing touched the VPS.

| Finding | Status | What was done / why not | Proof |
| --- | --- | --- | --- |
| R20-01 same-order foreign delivery plant (`driver_trips`, 0225) | **Recorded as gate (G2), open** | Needs a forward migration and an own-load control; not part of this narrow round. Fresh staging holds no historical mismatch. | `docs/REAL-DATA-GATES.md` G2 row |
| R20-02 purge aborts on a corrected, applied-then-rolled-back row (0228 vs CHECK of 0215) | **Recorded as gate (G3), open** | Contained: staging refuses import and purge. Added: a count-only audit is not proof of erasure. | G3 row |
| R20-03 padding budget resets per worksheet | **Recorded as gate (G7), open** | A workbook-wide budget is needed; history import is disabled in staging. | G7 row |
| R20-04 negative sweeps accept non-authorization failures; two predicates unasserted; decision 219 said accepted calls commit | **Recorded as gate (G2) + claim corrected** | Proof gaps, not a bypass. The decision-219 sentence was wrong (every sweep call is rolled back) and is corrected in `docs/DECISIONS.md` (219 (c)). The sweeps are not changed in this round. | G2 row, decision 219 |
| R20-05 deploy recovery can say "nothing switched" after the approval/checkout switched | **Recorded as production-path gate, open** | Production path only; staging resets and starts through `up.sh`. | new table in `REAL-DATA-GATES.md` |
| R20-06 `job-lib.sh` removes the container before the end record and ignores the append failure | **Recorded as production-path gate, open** | Not required for staging; the operator is told to stop on evidence errors (checklist item 5). | same table |
| R20-07 wrong commands / IPv6 blind spot in `docs/STAGING-VPS.md` | **Fixed (all nine rows + the SSH note)** | See below. The approved checkout on the VPS is not changed. | the guide; image/volume checks were run locally (below) |
| R20-08 `e2e-staging/` and `playwright.staging.config.ts` enter the runtime image | **Fixed** | `.dockerignore` now excludes `e2e-staging`, `playwright.staging.config.ts` and `**/*.spec.ts`; the Dockerfile has a comment pointing at the filter. | `scripts/dockerignore.test.ts` (3 tests: matcher controls, every tracked test source excluded, Dockerfile copies only through the filter) |
| R20-09 effective proxy hostname / TLS inputs escape validation | **Fixed** | `scripts/staging/dc.sh` refuses `APP_DOMAIN`, `APP_BASE_URL`, `STAGING_TLS`, `STAGING_HTTP(S)_PORT`, `STAGING_BIND_IP`, `STAGING_PLATFORM`, `STAGING_REHEARSAL`, `STAGING_PROFILE`, `REHEARSAL_IMAGE`, `POSTGRES_SUPERUSER_PASSWORD`, `DOCKER_CONFIG`, `BUILDKIT_HOST` in the shell, and any variable that either env file defines. `scripts/ops/validate-compose.py` (staging) requires: a single-line lowercase DNS host name (`fullmatch`, labels ≤ 63, ≤ 253), `STAGING_TLS=acme` (the internal CA only with `--rehearsal`), ports 80/443 on the VPS profile, and `APP_BASE_URL == https://<domain>` (plus the port in the rehearsal). All before any container-creating call. | `scripts/staging-config.test.ts`: 9 shell-override cases, 10 effective-config refusals (multi-line host, trailing newline, config token, scheme, no dot, internal CA, unknown mode, other origin, http origin, origin with port) with "no container call" asserted, valid inputs pass, rehearsal variant passes. Also run against the real `docker compose config` output: valid → accepted; multi-line domain, `STAGING_TLS=internal`, a different domain → refused. |

## R20-07, row by row (`docs/STAGING-VPS.md`)

1. §6: `sudo docker info` as `ubuntu`; the guide says Docker commands run as `deploy` from §5 on.
2. §7: split into "as `ubuntu` (sudo)" (`/srv/kayas`) and "as `deploy`" (key, ssh config, clone, pin).
3. §5: `chmod 0700 /home/deploy`, private `~/.ssh` and `~/.docker`, and a `stat` check of every mode.
4. §8: the image check reads the real image and fails by exit status (forbidden paths, secret env files vs the two example files, empty `/app/backups`, test sources); §10: a quiet check of the four fixed volume names (`kayas-staging_pgdata`, `_filestore`, `_accounts`, `_caddy_data`), other `kayas-staging` volumes and containers, with an exit status. Both were run locally (and `rehearse.sh` was re-run on the final code, rc 0): the content check exits 1 and names `/app/e2e-staging` on the image built before the fix and 0 on a clean older image and on the rebuilt rehearsal image.
5. §12: the training domain is referred to as `TRAINING_EMAIL_DOMAIN` (`src/lib/training.ts:4`), not copied.
6. §14 (and §4): the host's global IPv6 addresses are inventoried independently of DNS (`ip -6 -o addr show scope global`, provider panel) and every global address that exists is scanned externally.
7. §15: browser-close eviction and phone/PWA re-prompt are acceptance checks to observe, not guarantees; a forgotten Basic credential is not an app logout.
8. §16: the reboot command carries `-i ~/.ssh/kayas-staging-deploy` (the key named in §5).
9. §16: upgrade order is fetch and verify the next commit → pull the next private digest (login again) and check it → reset under the old approval → replace the approval → checkout → start.
10. §1: SSH currently allows port 22 from anywhere (key-only, fail2ban); restricting to the admin address is an optional later step.

## Gate wording (`docs/REAL-DATA-GATES.md`)

G2 target 0228 plus R20-01/-04; G3 R20-02 and "count-only audit is not erasure"; G7 twin validation PARTIAL/contained (uniform with R19B-03) and R20-03; G8 running-instance evidence separated from the scratch run, crash/rollback acceptance open; G10 the seed's two publications are separately fenced publications with identity-checked cleanup, multiprocess/crash evidence missing; G11/G12 acceptance on the real deployment (VPS in Canada); R20-05 and R20-06 added as production-path items. **All of G1–G12 remain OPEN.**

## Not done

No change to migrations, the sweeps, the importer, `deploy-*.sh` or `job-lib.sh` (all recorded as gates above). No image was built or pushed by this round; the real CI-built digest of the final commit is read from the CI run.
