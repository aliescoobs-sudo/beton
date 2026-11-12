# Independent security review R20 — narrow verification

Date: 2026-11-12. Target: `4191ccccce2725ebcbed7dc43979ee7612b2f0b3`.
Baselines: R19 `1a6d99018dd5025ebb444d6487fcdddcc90c40e8`; R19B `4243a705f59debc684c9809f59dfb59e23ec5c49`.

The initial fetch from the local filesystem remote succeeded; the target commit object exists. Reads used pinned Git objects. No app, tests, Docker, network service or VPS was run or accessed. No secret or untracked input was read.

**Verdict: GO for a fresh, fictitious-data staging instance, behind Basic Auth, training ON, using `scripts/staging/up.sh` and the remaining checklist below. Blocking R20 finding IDs: none. Real data: NO-GO; G1–G12 and the additional production gates remain OPEN.** This does not approve the production deploy/recovery path. The residual importer defects are contained by the staging profile; historical inconsistent tuples must not be copied into this fresh instance.

FIXED below means the named source defect is corrected and the inspected regression assertion distinguishes the previous behavior. No old/new test run was independently performed. Migration references are under `db/migrations/`; `history/` abbreviates `src/modules/importer/history/`.

## R19 verification

| Finding | Status | Source and test assessment |
| --- | --- | --- |
| R19-01 Actor-NULL/self-service doors | FIXED named doors; PARTIAL catalogue proof | `0224_admitted_actor_first.sql:13–29,33–259` validates actors before the named lookups and checks disclosure/document audiences. `tests/r19-01-admitted-actor.int.test.ts:81–138,175–306` creates real approved targets, asserts exact refusal and unchanged state for invalid/reserved/demoted/disabled actors, and has authorized controls. These assertions catch the old bypass. The broader sweep still has false negatives: R20-04. |
| R19-02 Joined reader tuples | PARTIAL | `0225_reader_tuple_scope.sql:29–74` and `0226_receipt_instruction_tuple.sql:8–42` close the manager NULL-plan and named joined-row paths. `tests/r19-02-reader-tuples.int.test.ts:111–286` and `tests/r19-step0-residuals.int.test.ts:58–171` use actual inconsistent tuples and own/owner controls; they distinguish the old queries. The phone's same-order foreign/NULL load remains: R20-01. |
| R19-03 Twin validation | PARTIAL; contained for staging | `history/domain/twin-content.ts:48–115`, `history/service/history-import.ts:354–365` add retained-field/correction checks. `tests/r19-03-twin-content.int.test.ts:149–217` supplies actual contaminated marked rows and corrections, checks unchanged counts, and stages a clean control. This catches the named omissions, not proof of wholly synthetic provenance. The accepted complete-validation deferral remains; staging disables import before I/O (`scripts/import-history.ts:41`, `history/service/history-import.ts:110–115`). |
| R19-04 Late logout headers | FIXED | `src/app/api/field/logout/route.ts:18–35` no longer deletes the shared cookie. `tests/r19-04-logout-cookie.int.test.ts:91–137` invokes the real route with real sessions and checks both successful-close and expired-old-token orderings plus revoked-token refusal. Its cookie/header delivery is modeled, not a two-browser test; the old deletion fails its assertions. |
| R19-05 Expiry/account fence | FIXED named defect | `0227_field_session_expiry_fence.sql:12–64`, `src/modules/field/service/auth.ts` and `src/lib/db/rls-context.ts` carry expiry into each transaction and serialize account changes. `tests/r19-05-expiry-fence.int.test.ts:89–154` uses signed tokens and actual taps; expiry before the next transaction refuses, and account changes wait. The delayed body is modeled at the service boundary. An already admitted transaction may finish after expiry; the test explicitly permits that. |
| R19-06 Erase debt | FIXED in source/fake storage; PARTIAL phones | `src/modules/field/ui/offline-store.ts:83–187` persists a second debt record, hydrates it and guards removals; `day-controller.ts:137–142` and `field-app.tsx:370–387,565–571` propagate persistence failure. `photo-store-r18.test.ts:267–312` reloads modules with localStorage refusing and asserts recovered debt/cleared stores; `day-controller.test.ts:242–255` checks the notice. These fail on the old implementation. G6 remains OPEN. |
| R19-07 Decision-bound confirmation | FIXED | `history/service/history-import.ts:313–405` recomputes decision hashes under the import lock; `history/service/staging.ts:99,258` takes that lock for mutations. `tests/history-cli.int.test.ts:294–348` pauses the actual CLI, changes a real mapping or fixed row, asserts refusal/no applied batch, and has an unchanged-decision control. Old CLI lacks the new phrase component, so its failure occurs before reproducing the complete old race; the new semantic assertion is meaningful. |
| R19-08 Rollback/client dependencies | FIXED named lifecycle | `history/service/history-import.ts:781–817` retains referenced clients. `tests/history-import.int.test.ts:534–620` creates a later live order and another history batch, rolls back the first, checks retained/archived counts and statuses, and uses the retained mapping again. The old unconditional archive fails these checks. Concurrent live use still belongs to G8. |
| R19-09 Authoritative strings | FIXED | `src/modules/importer/domain/sheet.ts:240–249,275–283,321–325`. `shared-strings.test.ts:35–158` asserts exact labels from a relocated relationship despite a decoy, rejects missing/ambiguous/non-table/out-of-range strings, and checks sanitized errors through history. These are actual package reads, not dummy argument tests. |
| R19-10 Coordinate amplification | PARTIAL | Row/column bounds and a single-sheet padding cap are real (`sheet.ts:293–335`). `coordinates.test.ts:19–77` exercises extreme coordinates and one-sheet amplification in both modes. The workbook-wide allocation bound is missing: R20-03. |
| R19-11 Nested metadata | FIXED named segments; accepted deferral | `src/lib/files/strip-metadata.ts:138–151,185–200,226–275` removes/rebuilds the named thumbnail/profile/frame containers. `files.test.ts:377–510` asserts actual canary removal and picture/orientation preservation; `tests/driver-bl-photo.int.test.ts:229–245` checks the sealed upload/download. The old retained segments fail these assertions. Independent decoding/re-encoding remains the accepted G9 deferral. |
| R19-12 Seed publication/recovery | FIXED named interleavings | `scripts/training-lib.ts:299–321,382–425,623–688` makes cleanup publication-specific and rechecks exclusive dead-mutex recovery. `training-lib.test.ts:628–719` pauses real file publication around a successor and checks file/marker preservation; recovery uses explicit seams and process liveness. The old cleanup removes the successor's file. The old recovery lacked the seam, so that comparison is source reasoning; real multiprocess/crash evidence remains G10. |

## R19B verification

| Finding | Status | Source and test assessment |
| --- | --- | --- |
| R19B-01 Staging/Basic Auth | FIXED for generated configuration; host pending | `Caddyfile.staging:66–100` imports Basic before its sole app proxy, including API/phone/RSC paths; hash is a mounted file. `docker-compose.staging.yml:59–169` exposes only the proxy and forces staging/training. `scripts/staging/rehearsal-checks.sh` checks denial methods and an unchanged app-side login counter with a positive control; `e2e-staging/basic-auth.spec.ts` exercises the gate/PWA. Source inspected; the claimed local rehearsal was not rerun. Effective hostname inputs need hardening: R20-09. |
| R19B-02 Approved execution | PARTIAL | `scripts/ops/release-lib.sh:28–114` strictly parses approval, rejects image/Compose/context overrides, checks host commit/edits and validates resolved images/options. Production and staging wrappers use it. `scripts/release-binding.test.ts` mutates these inputs and asserts no container-creating call. Docker is stubbed. Completed evidence can still be lost without failing the job: R20-06; deploy recovery: R20-05. |
| R19B-03 Twin-only staging | CONTAINED, not fixed | Forced `STAGING_PROFILE`, service/CLI early refusal and no importer mount. `scripts/staging-profile.test.ts:61–171` uses a pool that throws if touched, nonexistent files, actual CLI subprocesses, and mount mutations. It proves early containment and would fail without the guard. The accepted real-import redesign remains OPEN. |
| R19B-04 Hidden prompts | FIXED shared mechanism | `scripts/prompt.ts:24–65`, `scripts/staging/make-basic.sh:26–59`, `scripts/ops/bootstrap.sh` and interactive ops wrappers. `scripts/operator-path.test.ts:57–244` drives a pseudo-terminal, checks canaries absent from transcript/arguments and checks private modes. These assertions distinguish the old echo/next-prompt defect. Owner/import/recovery CLIs were not independently driven end to end. |
| R19B-05 Host verifier | FIXED named fail-open | `scripts/ops/verify-host.sh:24–92` rejects failed/unparseable Docker/listener inventory and judges each binding. `operator-path.test.ts:253–389` injects failed commands, mixed/explicit/IPv6/UDP bindings, privileged/host-network containers and stray listeners. It now fails these cases; host/firewall proof is still external. |
| R19B-06 Backup ownership/pruning | DEFERRED production gate | Unchanged, explicitly OPEN in `docs/REAL-DATA-GATES.md:27`. Staging resets; no backup/restore claim is accepted. |
| R19B-07 Replacement-host recovery | DEFERRED production gate | Unchanged, explicitly OPEN at `docs/REAL-DATA-GATES.md:28`. Not reopened as a staging requirement. |
| R19B-08 Deploy rollback | PARTIAL | Lock and readiness/public-route verification are substantive. `release-binding.test.ts:457–608` checks recovery failures and kills a process during migration. It misses the pre-journal switch window: R20-05. |
| R19B-09 Writable maintenance paths | FIXED source; host evidence pending | `docker-compose.prod.yml`, `scripts/ops/init-host.sh`, Dockerfile and RUNBOOK provide writable mapping/report paths and the interactive wrapper. `operator-path.test.ts:608–634` verifies the wiring, not Linux UID/GID behavior. The new staging guide still contains executable-procedure errors: R20-07. |
| R19B-10 CI publication gate | FIXED workflow | `.github/workflows/build-image.yml:40–50` requires checks and the callable integration job for push/tag/manual publication. `integration.yml:8–14` has no privileged PR trigger; no `workflow_run`, `always()` or `continue-on-error` bypass appears. `release-binding.test.ts:621–640` asserts wiring. Actual GitHub outcomes/protection unavailable here; accepted branch-protection deferral unchanged. |
| R19B-11 LAN relay shutdown | FIXED named path | `scripts/training/relay-stop.sh:12–32`, `training-down.sh:6`, capped `lan-relay-core.mjs`. `operator-path.test.ts:429–606` uses real loopback sockets with the shared core, checks shutdown, lost/reused PID and TERM-resistant relay. CLI stand-in is explicit; real LAN/Wi-Fi unverified. LAN door is absent from staging. |
| R19B-12 Twin helper scope | FIXED named sequential case | `scripts/training-twin-lib.ts:74–114`, `history/service/staging.ts:173–235`. `tests/twin-decide-scope.int.test.ts:70–116` stages two real sets, checks preview/refusal and scoped quarantine mutation. Labels remain global; the helper refuses their mutation while another set is pending. Staging import remains disabled. |

## Residual findings

### R20-01 · MEDIUM · Same-order foreign load still reaches a phone reader

**Access/trigger:** assigned phone token, or app-login SQL as that driver, plus a historical inconsistent delivery: plan/order in A, linked delivery in B or NULL, with the same order ID. `0225_reader_tuple_scope.sql:49–53` constrains `driver_trips` by order ID but never by delivery plant. Its `trip_stages` replacement at `:47–48` checks delivery plant only for a plant manager. The phone can receive that delivery's BL number and linked-load status through SECURITY DEFINER reads.

**Fix:** require the linked delivery's authorized plant tuple as well as order identity; preserve legitimate cross-plant assignments. **Verify:** attach a B/NULL delivery to the driver's otherwise consistent own-order trip, assert no BL/link disclosure, and include an own-load control. `tests/r19-02-reader-tuples.int.test.ts:261–286` tests a foreign *different-order* load only. Fresh staging has no imported historical mismatches; not a staging blocker.

### R20-02 · MEDIUM · Purge fails on a corrected, applied-then-rolled-back set

**Access/trigger:** authorized history operator corrects a quarantined row, applies, rolls back, then confirms purge. `0228_purge_staging.sql:80–82` sets `fixed = NULL` while retaining status `fixed`; `0215_history_import.sql:80` still requires a non-NULL correction for that status. Applied rollback leaves the quarantine status intact (`history/service/history-import.ts:825–827`). The CHECK aborts the entire purge, retaining the private cells.

**Fix:** add a forward migration reconciling the CHECK with an immutable purged state. **Verify:** actual corrected row → apply → rollback → purge; assert erased raw/correction, purge marker and count-only audit. `tests/r19-g3-purge-staging.int.test.ts:140–199,255–334` purges discarded staging but leaves its corrected applied control applied, missing this lifecycle. Contained by staging's import/purge refusal; G3 is not closed.

### R20-03 · MEDIUM · Padding budget resets for each worksheet

**Access/trigger:** operator-supplied workbook with many individually legal wide worksheets. `src/modules/importer/domain/sheet.ts:286–293` initializes `pad` inside the sheet loop. Hundreds of XFD-positioned cells per sheet can allocate millions of slots each while remaining far below the global cell and ZIP-size limits. The promised cumulative workbook budget is bypassed, risking process memory exhaustion.

**Fix:** enforce the padding/allocation budget across the whole workbook, before allocation. **Verify:** two or more sheets individually below the limit but collectively above it must refuse; keep a below-budget multi-sheet control. `coordinates.test.ts:59–65` covers only one amplified sheet. History import is disabled in staging; G7 remains OPEN.

### R20-04 · MEDIUM · Broad negative sweeps still accept non-authorization failures

**Access/trigger:** developer removes a guard while argument parsing still rejects the sweep's dummy request. `e2e/sweep-support.ts:133–159,217–218` sends `{}`, truncates results to 400 characters, accepts a 200 without a literal success substring, and treats 500 as a positive “reached” control. `e2e/role-negatives.spec.ts:178–197` explicitly allows accountant actions to fail on missing arguments. No audited write with an invalid request does not prove authorization. `serverActions():69–84` can silently return an empty inventory.

The SQL catalogue is stronger but `tests/definer-catalogue.int.test.ts:481–488` never asserts that its two “answers empty” predicates actually return false; a true result without a write passes. `:491` always rolls back, contradicting decision 219's claim that accepted calls commit.

**Fix:** require a nonempty action inventory, valid real targets/payloads and successful authorized controls; assert semantic denial from complete responses, exact false/empty predicate results, and meaningful state checks. Correct the commit claim. **Verify:** remove each tested guard and make each exempt predicate return true; the corresponding negative must fail. These are proof gaps, not a demonstrated browser authorization bypass. Full e2e is still outside CI; the integration publication gate does not cover these sweeps.

### R20-05 · MEDIUM · Recovery can declare “nothing switched” after switching approval/checkout

**Access/trigger:** operator deploy interrupted after `scripts/ops/deploy-stage.sh:63` or `:64`, before `:65` records `switched`. The journal still says `pulled`/`backup_ok`. `deploy-run.sh:57–64` marks that state recovered before checking service health; it neither restores the old approval/checkout nor proves the running container matches the new approval. After checkout succeeds, the old healthy container/public page can produce false recovery success without new migrations/startup. A failure can also leave a terminal `recovered` marker prematurely.

**Fix:** durable write-ahead switch intent; reconcile approval, checkout and actual running image on recovery, marking terminal success only afterwards. Journal writes must fail closed and be flushed; `deploy-lib.sh:6–9` is only a shell append, and phase 2 does not use `set -e`.

**Verify:** SIGKILL immediately after approval publication and after checkout, before `switched`; recover and assert exact old release restoration or completed verified new release. `release-binding.test.ts:558–608` kills after `switched`, missing both windows. Production path only; staging uses reset/up.

### R20-06 · MEDIUM · Lost completion evidence does not fail the privileged job

**Access/trigger:** disk full, quota or an evidence write error after a privileged job completes. `scripts/ops/job-lib.sh:48–58` deletes the inspectable container before appending its end record, ignores append failure with `|| true`, and returns job success. Staging startup can continue with only a start record and no recoverable actual execution identity.

**Fix:** require successful end-record persistence before removing the container/reporting success; retain the container or independent recovery evidence on failure. **Verify:** let the start append succeed, fail the end append after a successful migrate/seed, and require nonzero exit with retained evidence/container. Existing match/mismatch stub tests do not exercise this failure. Operational evidence gap; not a fictitious-data confidentiality blocker.

### R20-07 · MEDIUM · VPS procedure contains wrong commands and an IPv6 blind spot

**Access/trigger:** owner follows `docs/STAGING-VPS.md` on the supplied VPS state.

| Reference | What the operator experiences / correction |
| --- | --- |
| `:91` | `ubuntu` is not in the Docker group: `docker info` is denied. Use `sudo docker info` here; later Docker commands run as the newly provisioned deploy account. |
| `:99–108` | A block labeled “as deploy” contains sudo directory setup, although deploy has no sudo. Separate the `ubuntu` setup from deploy's clone commands. |
| `:127` | The claimed home mode 0700 is never set. Explicitly set/check it, along with private SSH/Docker config permissions. |
| `:135,150` | Image inspection flags intentionally retained example env files and an intentionally created empty backup directory, yet does not fail; volume listing prints a header even when empty. Use content-aware, exit-status checks and a quiet volume inventory, including the fixed volume names. R20-08 also applies. |
| `:179` | Expected training account domain disagrees with `src/lib/training.ts:4`; following it suggests a valid seed is wrong. Reference the training-domain constant. |
| `:202` | No AAAA record does not mean no public IPv6 address. Inventory host/provider IPv6 and externally scan every global address that exists; the supplied state establishes DNS only. |
| `:208–210` | Browser-close credential eviction and phone/PWA re-prompt behavior are asserted without supported-phone proof. Treat them as acceptance checks, not guarantees; a forgotten Basic credential is not app logout. |
| `:218` | Reboot SSH omits the non-default identity file created at `:65`; a fresh client without an agent/alias may get public-key denial. Include `-i` or configure the alias. |
| `:224` | Upgrade deletes data before ensuring the new commit/image exists, and omits pulling the private image after registry logout. Approval can fail on an unknown commit; otherwise startup can fail with unauthorized pull. Fetch and verify/pull the next approved digest before reset; then reset under the old approval, replace approval, checkout, start. |

**Fix:** correct/order the guide; do not change the approved checkout on the VPS to patch it. **Verify:** walk the corrected commands as distinct `ubuntu`/deploy sessions, with an empty image cache and no SSH agent; rehearse reboot and a disposable upgrade. These are correctable operator prerequisites, not a discovered bypass of the generated staging gate. The supplied SSH rule remains public; key-only/fail2ban are present, but admin-source restriction is not yet established.

### R20-08 · LOW · New staging e2e sources enter the runtime image

**Access/trigger:** normal build. `.dockerignore:28–35` excludes `e2e`, tests and `*.test.ts`, but not `e2e-staging/basic-auth.spec.ts` or `playwright.staging.config.ts`. `Dockerfile:9,23` copies them into runtime, contrary to the source-exclusion claim. They are test sources, not evidence of embedded real secrets.

**Fix:** exclude the new test directory/config and update the image inspection. **Verify:** inspect the final approved image and assert these paths absent, while checking permitted example env files separately from secret env files. Not a staging blocker.

### R20-09 · LOW · Effective proxy hostname/TLS inputs escape validation

**Access/trigger:** control of the operator's deployment environment/private configuration; no browser-only primitive found. `scripts/staging/init-env.sh:8–9` validates its initial hostname, but later `dc.sh:51–54` inherits shell interpolation variables. `docker-compose.staging.yml:111–121` passes them to Caddy; `scripts/ops/validate-compose.py:156–162` does not validate the effective hostname, TLS mode or origin agreement. `Caddyfile.staging:66–67` expands them as configuration text. A multiline hostname value can inject another site block; an inherited TLS mode can select the rehearsal CA on the VPS.

**Fix:** reject unexpected shell overrides and validate a single effective DNS hostname, matching HTTPS app origin, and ACME-only server mode before startup. **Verify:** multiline/config-token hostname and inherited internal-CA inputs refuse before a container-creating call; valid generated inputs pass. Existing Caddy adaptation checks use fixed benign hostnames. Not a remote-header bypass; fresh helper-generated files and a clean deployment environment contain this for the proposed start.

## Other checked surfaces

| Surface | Result |
| --- | --- |
| New actor helpers/definers, declared search paths and grants | Checked, no issue beyond the residual readers/purge above; applied ACL/owner state unverified. |
| Reserved boundary replacement/shadowing and production imports of the test switch | Checked, no issue in the pinned migration/bootstrap/startup paths. |
| Phone device-row identity, logout CAS, token expiry propagation and field transaction fence | Checked, no additional source issue; real-phone races remain G5/G6. |
| Normal generated Caddy route order, API/phone/static/error paths, forwarded headers | Checked, no browser-accessible gate bypass found. Only TCP 80/443 published; no direct app/DB host port, UDP HTTP/3 publication or configured h2c bypass. WebSocket upgrade enters the same gate. ACME behavior still needs host verification. |
| Staging providers, push and real import | Checked, no issue in forced flags/absent keys/import refusal; no importer bind or LAN relay in staging. |
| Script argument quoting, approval parsing, private creation and prompt paths | Checked, no additional shell-evaluation defect found. No approval file is sourced. Symlink rejection/exclusive creation cover the named final files; trusted deployment-directory/PATH ownership is still a host prerequisite, not established by this review. |
| Container hardening and resource/log limits | Checked, no additional source issue for staging; privileged root-equivalent Docker access and env-based secrets are explicitly accepted staging limitations. |
| CI tag/manual/PR event paths and publication dependency | Checked, no integration-dependency bypass found in the pinned workflows. External actions/base tags remain supply-chain inputs under G1. |

## Real-data gate wording

**G1–G12 are all still explicitly OPEN. Their wording is not fully consistent.** Keep the accepted R19B-03/06/07, R19-11 and branch-protection deferrals; none is closed by this review.

- `docs/REAL-DATA-GATES.md:8` still names migration rehearsal only through 0223 and carries the old reader-audit qualification. Update the target through 0228 and retain the actual remaining tuple/HTTP evidence (R20-01/04).
- `:9` needs the corrected-row purge exception above; count-only audit is not proof that erasure completed (R20-02).
- `:13` describes field-by-field twin checks without the complete-validation limitation explicitly carried at `:26`; make containment/PARTIAL uniform. The allocation claim also needs R20-03.
- `:14` simultaneously says the twin ran on the running instance and that it ran only on scratch. Identify which evidence belongs to which run; leave crash/rollback acceptance OPEN.
- `:16` calls both seed publications one commit step. They are separately fenced publications with identity-checked cleanup. Describe that accurately; retain multiprocess/crash evidence as missing.

The supplied host is in Canada. Future real-data operational/location acceptance must use that actual deployment context, not inherit assumptions from the earlier Swiss-provider plan. This is a G11/G12 evidence requirement, not a new staging blocker.

## Minimal remaining deployment checklist

1. As `ubuntu`, provision the dedicated deploy account/key and `/srv/kayas`; set/check private home/SSH permissions, then prove a second key-only deploy session and Docker access. Keep the existing session/rescue access. Existing SSH/UFW/fail2ban/updates/swap setup need not be repeated; use sudo for root-only host checks.
2. Obtain a successful CI publication for the exact reviewed target; pin the host checkout, record commit/digest/platform/run ID in approval, pull that private digest, verify amd64, and log out of GHCR. Inspect the actual image contents using corrected checks; source exclusions alone are not artifact evidence.
3. Generate fresh staging env files and a distinct Basic credential with the provided helpers; verify 0600/private parents without printing values. Use a clean shell: no image/Compose/context/rehearsal or proxy-domain/TLS overrides; generated domain/origin must agree and TLS must be ACME.
4. Confirm the fixed staging volume names and project inventory are genuinely unused; retain the reset-only policy. Inventory public IPv6 independently of DNS. Prepare the corrected external checks and explicit-key reboot command before starting.
5. Start only through `scripts/staging/up.sh`. Before sharing access, require valid public TLS; unauthenticated/wrong-Basic rejection on page/API/phone paths; authorized Basic plus app-login controls; an external all-port scan of every public address; fail-closed host verification; owner/admin TOTP enrollment; and reboot readiness. Verify complete ops end records and stop on storage/evidence errors. Supported-phone Basic/PWA behavior must be observed, not assumed from the local desktop rehearsal.

## What could not be verified

No live database, installed function/ACL catalogue, historical mismatch inventory, actual secret permissions, final CI run/image/provenance, container execution, external scan, provider firewall, DNS/ACME issuance, IPv6 inventory, disk-full behavior, reboot, supported phone or VPS state was independently inspected. The supplied VPS description was treated as input. Claimed local rehearsals/green runs were not reproduced; ignored logs/evidence were deliberately not read. Stub-Docker, fake IndexedDB, modeled header delivery and conditional test skips limit the inspected tests' operational proof. Production backup/replacement-host recovery and two-real-image migration rollback remain accepted OPEN gates.

Only this report was written.
