# Independent security review R19

**Verdict: fictitious-data staging NO-GO (R19-01–06, R19-12). Real data NO-GO (R19-01–12; G1–G12 remain OPEN).**

Target `1a6d99018dd5025ebb444d6487fcdddcc90c40e8`; baseline `47ac7dc09d9433b7d8e106f0e03b0dcbd85f0823`. Initial fetch succeeded using the clone’s local filesystem remote; target existence was confirmed. Source reads used pinned objects only. Migration filenames below are under `db/migrations/`; `history/` abbreviates `src/modules/importer/history/`.

FIXED means the named defect is corrected in source and a meaningful regression assertion was inspected. Tests were not executed; whether they fail on the old implementation is assessed from source, not independently demonstrated.

## 1. R18 status

| Item | Status | Code, regression assertion, remaining gap |
| --- | --- | --- |
| R18-01 Joined plant scope | PARTIAL | `0218_plant_scope_references.sql:8–188` closes the named plan-reference, manager timing, dispatch and timeline paths. `tests/r18-01-scope-references.int.test.ts:43–250` uses actual B/NULL references, historical mismatches, positive controls, matching denial text/SQLSTATE and unchanged row/audit counts; these assertions distinguish the old behavior. Other joined readers remain: R19-02. |
| R18-02 NULL-role definers | PARTIAL | `0217_actor_first_trip_doors.sql:9–69` puts actor validation before the four named doors and makes `transfer_actor_ok` return false for NULL. `tests/r18-02-actor-first.int.test.ts:55–278` uses actual eligible trips/loads/stages and positive controls; `:279–319` proves the fuel-opening fix with a real plant. Despite its title, that last test calls none of the three transfer doors. The broader class survives: R19-01. |
| R18-03 Reserved accounts | PARTIAL | `0220_reserved_boundary.sql:10–131`, `src/modules/platform-security/auth/session-lifetime.ts:47–68`, `src/modules/platform-security/service/reserved-admission.ts:37–82` close normal actor/session/field admission, committed cleanup and missing-function handling. `tests/r18-03-reserved-boundary.int.test.ts:57–259` uses stored reserved users, old cookies, session retargets and linked field accounts. Some self-service definers bypass actor resolution (R19-01); HTTP coverage is incomplete (§4). |
| R18-04 Rebound phone token | FIXED | `0216_field_session_device_row.sql:5–45` and `src/modules/field/service/{session.ts,auth.ts}` bind the signed token and check/close to the device-row ID. `tests/t10c-field-revocation.int.test.ts:110–154` releases/rebinds the same device, forces a generation collision, refuses the actual old token’s read/close and preserves the new session. The old implementation lacks that distinguishing row identity. |
| R18-05 In-flight writes / logout | PARTIAL | `0222_field_session_fence.sql:5–33`, `src/lib/db/rls-context.ts:77–82` fence each field transaction against the device row. `tests/r18-05-session-fence.int.test.ts:63–108` holds a real tap, makes revocation wait and proves later taps stop; old code continues. Logout CAS-false handling is corrected, but successful-CAS delayed headers still race (R19-04), and admitted requests lose expiry (R19-05). |
| R18-06 Photo erasure | PARTIAL | `src/modules/field/ui/photo-queue.ts:347–520,741` adds covering tombstones, lease checks and blocked-store failure; `photo-store-r18.test.ts` exercises paused copies, expired leases and actual fake-store contents. Persistence failure is retained only in memory, without the promised UI/reload guarantee (R19-06). |
| R18-07 Billing gate doors | FIXED | `0219_delivery_gate_doors.sql:13–164` removes app INSERT and scopes explicit manual/trip doors. `tests/r18-07-gate-doors.int.test.ts:49–228` uses foreign/NULL/own loads, driver and implicit finishes, actual queue/invoice attempts and normal positive controls. Old raw inserts and premature confirmation fail these assertions. R19-02 concerns other readers, not reopening this door. |
| R18-08 Held count | FIXED | `0221_held_count_own_query.sql:8–43` counts without order/truck/amount/detail work and bounds the range. `tests/r18-08-held-count.int.test.ts:59–204` checks real holds, irrelevant large totals, internal ACLs and A/B/NULL scope. `e2e/held-count-banner.spec.ts:98–130` uses a seeded hold and checks plain-office HTML/RSC for detail canaries. `src/modules/operations/domain/held-banner.test.ts:5–18` distinguishes unavailable from zero. Old detail aggregation/zero fallback would fail the corresponding assertions. |
| R18-09 Workbook/calendar guard | FIXED | `src/modules/importer/domain/sheet.ts:190–259` and `xml-flags.ts` resolve the authoritative main part and reject malformed structure. `workbook-package.test.ts:22–126` has a valid 1900 control, relocated 1904/decoy, missing and duplicate parts. `tests/history-package-guard.int.test.ts:64–142` applies the same reader to history and checks unchanged tables. New shared-string/coordinate defects: R19-09/09. |
| R18-10 Compose override | FIXED | `scripts/training/dc.sh:24–68` requires an allowed subcommand first and validates effective app/ops images. `scripts/training-effective-image.test.ts:128–147,180–271` supplies the actual valued-option exploit and service-image substitutions, asserting refusal before execution and effective image values. Old wrapper accepts the named exploit. Docker is stubbed. |
| R18-11 Ops evidence / seed commit | PARTIAL | `scripts/training/ops.sh:20–79` records inspected completed jobs; `training-ops-evidence.test.ts:91–169` asserts image/platform/exit evidence using a Docker stub. `training-lib.test.ts:534–580` meaningfully pauses inside each mutex-protected action. Publication lifecycle and dead-mutex recovery still race (R19-12); actual release/host evidence remains G1/G10. |
| R18-12 Photo metadata | PARTIAL | `src/lib/files/strip-metadata.ts:83–154` now traverses scans through EOI and drops trailing images/bytes and ordinary MPF APP2. `files.test.ts:133–174` checks between-scan/after-EOI canaries, entropy preservation and malformed endings; `tests/driver-bl-photo.int.test.ts:189–211` checks sealed download. Retained thumbnail/profile metadata remains R19-11. |

### R17 leftovers

Only the nine items previously marked PARTIAL are reconsidered.

| Item | Status | Evidence / remainder |
| --- | --- | --- |
| R17-01 Image override | FIXED | R18-10 code and exploit regression above. Artifact provenance remains a separate G1 requirement. |
| R17-02 Plant isolation | PARTIAL | R18-01 regressions close named references; R19-02 retains reader/NULL-plan leaks. |
| R17-03 Reserved accounts | PARTIAL | R18-03 authentic session/SQL regressions above; R19-01 bypasses the shared actor boundary. |
| R17-04 NULL-role definers | PARTIAL | Real-target trip/fuel tests above close named doors; catalogue omissions and requester-only doors remain R19-01. |
| R17-05 Quoted XML | FIXED | `xml-flags.test.ts:14–30,65–89` plus the R18-09 authoritative-package tests reject the original quoted/calendar variants. Shared strings are a separate R19-09 defect. |
| R17-07 Photo loss/resurrection | PARTIAL | Tombstone/lease regressions in `photo-store-r18.test.ts` cover the reported interleavings. Supported-phone and storage-fault evidence remains G6; R19-06 persists. |
| R17-08 Hidden erase failure | PARTIAL | Blocked storage is now unknown and tested; nondurable debt still disappears after reload (R19-06). |
| R17-09 Seed lock | PARTIAL | Epoch/high-water preservation and individual commit fencing have regression assertions in `scripts/training-lib.test.ts:464–512,534–580`; R19-12 survives. |
| R17-10 Startup pre-check | PARTIAL | Effective-port/inventory tests remain `scripts/training-upgrade-precheck.test.ts:93–119`; ops evidence now has assertions. The “invalid” case at `:120–123` still runs only a healthy control. Real upgrade/provenance evidence remains G1/G10. |

## 2. New findings

### R19-01 · HIGH · Requester-only definers bypass actor validation

**Access:** app-login SQL with a real user UUID and target. `0088_disclosure.sql:89–114,127–134`: `view_disclosure` checks requester equality but never validates the role; with a valid approved request, a non-NULL requester and unset role it can return the financial figure and consume a view. Audit requires a user ID, not a non-NULL role (`0076_assistant.sql:20–32`). `my_disclosures` also returns records for reserved users without calling the reserved boundary. Siblings: `0112_document_copy_gate.sql:6–55`, `0089_notifications.sql:168–208`, `0092_darija.sql:18–31`.

**Fix:** validate an active, admitted actor before every self-service lookup/write, then enforce the permitted audience and requester. **Test:** real approved disclosure/document requests, notifications and users; unset/empty/wrong/reserved roles with the production boundary ON; exact refusal and unchanged state, plus authorized positive controls.

The catalogue misses these targets: `tests/definer-catalogue.int.test.ts:64–72` excludes history and auth-login capabilities; `:100–112` leaves `p_id` dummy and misidentifies several argument types; `:160–162` accepts every exception. Its regex exemption at `:207–209` does not establish that validation dominates a lookup.

### R19-02 · HIGH · Related-row and NULL-plan leaks remain

**Access:** plant-manager browser/app SQL, or an assigned phone token, with historical inconsistent references; the NULL-plan emergency case needs no inconsistency. `0084_field_app.sql:286–305` explicitly admits NULL-plant plans to scoped managers and returns emergency notes and joined identities.

`0210_trip_delivery_gate.sql:196–248` scopes only the plan while returning joined order/truck/load data and aggregating all deliveries/plans for an order. `0095_plant_scope_reads.sql:69–92` scopes a BL through its order, not the delivery; `:3–40` leaves child aggregates unscoped. `0108_pump_scope.sql:133–155` scopes jobs but not their joined orders. `0084_field_app.sql:149–175` checks driver assignment alone before returning joined contacts/site/BL data; an A plan linked to a B/NULL order/load exposes that tuple. `trip_stages` (`0210_trip_delivery_gate.sql:154–188`) likewise trusts plan scope for linked-stage status. Legitimately assigned cross-plant work is not itself a defect.

**Fix:** enforce authorized parent/child tuples on reads as well as future writes; remove the manager NULL-plan exception. **Test:** actual A/B/NULL historical mismatches through each reader and serialized page/API/BL payload, with own-tuple controls. The new scope suite covers dispatch/timeline/timing, not these siblings.

### R19-03 · HIGH · Marked twins can carry real content into training

**Access:** operator-provided workbook or history-admin browser corrections. `history/domain/guard.ts:47–57` accepts a marker, a substring in selected names and an expense vocabulary. `history/service/read-set.ts:123–139` omits notes, legacy fields, truck and BL text from those checks; `history/domain/parse.ts:231–251` preserves them. A marked twin with a private canary added to an observation/legacy cell can be staged/applied. Corrected quarantine values are merged only after the environment check (`history/service/history-import.ts:239–245,303–325`), so they bypass even those selected checks.

**Fix:** validate all persisted effective fields and decisions against the generated twin’s permitted content/provenance; reject contaminated marked files before staging. A marker alone is not proof of synthetic origin. **Test:** marked twin plus canaries in every retained field and a post-stage correction. `tests/history-staging-rules.int.test.ts:307–328` tests intact twin versus wholly unmarked files only.

### R19-04 · MEDIUM · Successful old logout can delete a fresh cookie

**Access:** phone browser with two tabs and no Web Locks. Old logout’s CAS succeeds, its response is delayed, a fresh login sets a cookie, then the old deletion header arrives. `src/app/api/field/logout/route.ts:23–35` deletes after successful CAS, and also after expired/invalid token verification. `src/modules/field/ui/session-lock.ts:12–19` simply runs the request without Web Locks. Result: the new session loses its cookie.

**Fix:** let server revocation stand without an unconditional shared-cookie deletion, or provide a supported cross-tab serialization mechanism covering response delivery. **Test:** pause headers after successful close, log in elsewhere, release headers, verify the fresh cookie/session; repeat for an expired old token. `route.test.ts:99–125` makes the newer generation exist before the old close, testing CAS-false only.

### R19-05 · MEDIUM · Admitted phone requests lose token expiry

**Access:** still-valid phone token near expiry. `src/app/api/field/context.ts:40–47` checks expiry before the body is read; `sync/route.ts:8–13` and `bl-photo/route.ts:8–20` then await client-controlled bodies. `src/modules/field/service/auth.ts:319–338` discards `exp` from the resulting actor, and `0222_field_session_fence.sql:16–25` checks device generation/status only. A request admitted just before expiry can finish its body and start mutations after expiry, within the ingress request deadline. Subsequent transactions of an admitted batch also have no expiry check.

**Fix:** retain the verified expiry in the field context and enforce current trusted time before each transaction. **Test:** admit a real signed token, hold the request body until after expiry, release a valid tap/photo and assert no write; also cross expiry between two batch transactions. Current revocation tests change generation/status, not expiry.

### R19-06 · MEDIUM · Erase debt is lost after storage refusal and reload

**Access:** phone browser with storage faults. `src/modules/field/ui/offline-store.ts:67–103,111–151` keeps refused persistence in module memory. `day-controller.ts:134–138` ignores `persistFailed`; `field-app.tsx:365–381,558–568` shows no nondurable-state notice. Reload loses that debt and notice while failed photo deletion may leave rows. Initial `localStorage.removeItem` calls at `offline-store.ts:115–116` can also throw before debt is recorded.

**Fix:** propagate nondurable status to the actual UI and retain/reconstruct pending cleanup across reload using durable storage/fail-closed account handover. **Test:** failed debt persistence plus aborted photo erase, module/browser reload, then assert both stores and UI. `photo-store-r18.test.ts:232–245` retries in the same module; its reload case at `:248–258` uses working persistence.

### R19-07 · MEDIUM · Import confirmation omits mutable staging decisions

**Access:** history-admin browser while an operator confirms the CLI. `history/service/read-set.ts:47–50` hashes files and mapping only; `history-import.ts:41–48,239–245` binds step-up to that hash. Effective fixes and identity/category decisions are read later (`:303–325`). `history/service/staging.ts:88–113,212–258` can change them without the import advisory lock or a decision revision. The same confirmed proof can therefore apply different parties, dates or amounts.

**Fix:** hash/version the exact effective decisions in the preview and confirmation; revalidate under a shared mutation lock before apply. **Test:** pause the actual CLI at the second-factor prompt, change a real mapping/fixed row from another actor, then require refusal with no writes. `tests/history-cli.int.test.ts` tests wrong/replayed/cross-operation codes, not changed staging state.

### R19-08 · MEDIUM · History rollback can archive a subsequently used live client

**Access:** authorized operator rolling back an earlier batch. `history/service/history-import.ts:445–468` intentionally creates live clients; `:691–707` later archives every client attributed to that batch without checking subsequent live use or other batches. The global label mapping remains. A client used after import can lose new-order eligibility (`0032_sales_order.sql:131–133`) because an unrelated historical batch is reversed.

**Fix:** inventory later references and retain shared clients; report retained versus archived clients and keep mappings usable. **Test:** import/create client, use it in a real later order and second history batch, roll back the first batch, assert the live client remains active. `tests/history-import.int.test.ts:409–457` checks history rollback, not this dependency lifecycle.

### R19-09 · HIGH · Shared strings still come from a filename, not the package

**Access:** operator-supplied workbook. `src/modules/importer/domain/sheet.ts:190–235` follows main/sheet relationships, but `:261–264` still reads only `xl/sharedStrings.xml`. A relocated valid 1900 workbook can reference another shared-string part while an unused canonical part supplies different strings. Excel and the importer then associate numeric cells with different headers/parties/categories, or the importer silently reads empty strings. Both T2 and history use this reader.

**Fix:** resolve and validate the authoritative shared-string relationship, or reject unsupported packages. **Test:** relocated 1900 workbook with real indexed cells and a decoy canonical string table; assert the exact parsed labels and refused ambiguity before writes. Current relocation tests refuse 1904 before reaching strings. Also sanitize diagnostics: `sheet.ts:207,229` interpolates package/sheet names into errors forwarded to reports at `history/service/read-set.ts:77`.

### R19-10 · MEDIUM · Tiny workbook coordinates can exhaust importer memory

**Access:** operator-supplied malformed workbook. `src/modules/importer/domain/sheet.ts:274–299` expands row gaps in `exactRows` and column gaps before any allocation bound. One very large row number or long column coordinate can allocate indefinitely despite the cell/file limits. History enables this mode at `history/service/read-set.ts:68–73`; parsing precedes actor/step-up checks at `history-import.ts:239–245`.

**Fix:** validate row/column coordinates and cumulative allocation before padding; use a bounded sparse representation. **Test:** small packages with extreme row/column references must refuse within fixed resource limits, before staging/apply. Existing package tests do not exercise coordinate amplification.

### R19-11 · MEDIUM · Retained thumbnail/profile segments defeat metadata removal

**Access:** phone-token BL upload. `src/lib/files/strip-metadata.ts:138–143` retains complete APP0/APP14 and ICC APP2 payloads. APP0 JFXX can contain a JPEG thumbnail with its own EXIF; that embedded image is never sanitized. Profile descriptions/creator text can also survive in retained ICC data, including PNG `iCCP` and WebP `ICCP` (`:159–175,201`). Accepted files are sealed and downloaded unchanged after this sanitizer.

**Fix:** remove embedded thumbnails and descriptive profiles, or decode/re-encode a bounded image with a normalized profile and permitted orientation only. **Test:** decodable JFXX thumbnail EXIF and ICC-text canaries through upload/download, plus MPF and accepted PNG/WebP cases. `files.test.ts:133–231` proves top-level/tail removal, not nested metadata or independent image decoding.

### R19-12 · MEDIUM · Seed exclusion does not cover publication cleanup/recovery

**Access:** operator running concurrent/resumed seeds after a stall/crash. `scripts/seed-training.ts:626–636` releases the commit mutex between credentials and marker. Pause after the first publication; a successor can take the stale epoch and publish its own credentials. The old marker attempt then fails its holder check, but `placed` remains true and cleanup unlinks the successor’s shared final path. `scripts/training-lib.ts:595–600` checks no publication identity. The result can be a completed marker with missing current credentials.

Separately, dead-mutex cleanup at `training-lib.ts:303–324` reads a dead PID and later unlinks the pathname without proving it still names that record. Two recoverers can remove a newly acquired live mutex.

**Fix:** protect credentials, marker and conditional cleanup as one lifecycle; give publications an attempt identity and use exclusive recovery that cannot unlink a replacement. **Test:** pause between the two real publications, complete a successor, resume the old catch; also pause a dead-record remover across mutex replacement. `training-lib.test.ts:534–599` tests individual actions and one dead mutex, not these orderings; `:602–607` is only a source-pattern assertion.

## 3. Other requested checks

- Definer declarations/replacements and rewrite loops through 0223, pinned search paths and declared EXECUTE grants were inspected. Auth-only PIN/device credential doors intentionally use the auth capability rather than an app actor. There is no separate PostgreSQL field login in this design. Applied owners, inherited privileges and the installed function catalogue remain unverified.
- Reserved switch DDL/shadowing and startup: checked, no issue in declared bootstrap/migration paths. `0000_roles_and_context.sql:5–32`, `scripts/db-bootstrap.ts:90–129` deny runtime CREATE/ownership; `0220_reserved_boundary.sql:10–15,34` uses an explicitly qualified migrator-owned constant ON. Missing/off admission fails startup (`src/modules/platform-security/boot.ts:91–114`). No production import of the test switch was found. This does not cure R19-01.
- Billing gate, held count and invoice authorization changes: checked, no issue beyond R19-01/02’s separate doors. The count has no amount/name/ID join, detail sort or discarded volume branch. Equal-count tests do not establish constant timing; uniform SQLSTATE/text tests do not measure timing differences for absent versus foreign references.
- History tables FORCE RLS and owner/app_admin staging, actor-checked aggregate doors and manager non-NULL plant filters: checked, no issue (`0215_history_import.sql:147–177,243–292`; `tests/history-import.int.test.ts:340–457`). New staging audit omits raw labels/cells (`0223_history_staging_rules.sql:8–40`); pre-0223 audit is not scrubbed. Stage intentionally precedes CLI second factor. Imported facts have no direct stock/invoice/ledger/trip/dispatch writers; live client creation is the documented exception, with R19-08.
- Runtime exclusion rules, strict wrapper and startup image checks: checked, no additional source issue. The built image was not inspected. Broad runtime COPY, tag-based Node bases and actual provenance remain G1.
- Generated PDF text/path handling in the delta: checked, no issue. Existing BL joined authorization remains R19-02; document metadata can contain document identifiers.
- Brand tag allowlist: checked, no issue. `scripts/brand-guard.test.ts:116–123,126–129,188–189` restricts it to exactly mapping, twin generator and three named history tests; `:251–280` checks exact paths, non-allowlisted paths and product-name rejection. No directory/glob exemption was added.

## 4. Negative-access coverage

“SQL/service” includes integration tests invoking services; it does not prove HTTP authorization. Entries describe the named guarantees, not a complete role matrix.

| Role | Page/browser coverage | API / HTTP coverage | SQL/service-only or missing guarantee |
| --- | --- | --- | --- |
| office | Existing accounts/cash/opening/statements/avoir/planning/trips denials; seeded held banner. | Held HTML/RSC canary exclusion (`e2e/held-count-banner.spec.ts:98–130`). Statement/export/PDF denials at `ledger-statements.spec.ts:67–80` use nonexistent IDs. | Real-target blind creator/RLS/oracle and held/detail separation in ledger exposure/count suites. Known-target PDF/export denial and plain-office history denial are not established by those browser tests. |
| office_sales | Blind invoice queue and history/staging denial (`e2e/invoice-queue.spec.ts:73–99`, `history-import.spec.ts:235–240`). | Queue page responses; no comprehensive mutation/API denial matrix. | SQL/service sales/purchases separation, no history/money access outside deliberate invoice-document permissions. |
| plant_manager | No office/money routes; actual A/B history page excludes B and expenses/staging (`e2e/history-import.spec.ts:222–231`). | No full existing-target foreign/NULL API, PDF, bulk or audit-payload matrix. | R18 scope/gate/count suites use real tuples at SQL/service level. R19-02’s emergency/reader mismatches have no targeted regression. |
| driver | Own phone day/no prices, offline/logout and account-handover scenarios (`e2e/driver-app.spec.ts`). | Wrong code/origin and unauthenticated sync (`:287–305`); normal photo flow/download (`:239–285`). | Other-driver target, immutable device identity and per-transaction revocation are primarily integration/service tests. No field-token sweep of all office APIs/pages or history endpoints; successful-CAS late-header ordering is uncovered. |
| pump_operator | `e2e/pumps.spec.ts:39–57` exercises an office browser on a phone, not an authenticated operator. | No comparable operator-token negative HTTP matrix. | Assignment/pump write denials, history/staging denial and field-account admission are SQL/service-level. Comprehensive operator page/API negatives are uncovered. |
| accountant | Existing book controls; history expenses-only and staging denial (`e2e/history-import.spec.ts:244–250`). | No comprehensive read-only write/API negative matrix. | Finance/ledger source/configuration/writer denials and history quantity denial are SQL/service-level. Replacing support fixtures with accountant is not reserved-role evidence. |
| partner | New real preexisting/upgrade-cookie GET page sweep (`e2e/reserved-roles.spec.ts:129–178`). | Same-cookie GET API sweep only. No partner password-login counterpart to the support case. | Both roles’ raw get-session, retarget, SQL and linked-field denial in `tests/r18-03-reserved-boundary.int.test.ts`. Self-service R19-01 and write-method/field-token HTTP coverage remain missing. |
| support | Same two GET sweeps; password session refusal (`e2e/reserved-roles.spec.ts:182–200`). | GET only; no POST/PUT/PATCH/DELETE/server-action sweep. | Same SQL/session positives and omissions as partner. |

Sweep limits: `e2e/reserved-roles.spec.ts:80–113` discovers protected `page.tsx` and API routes, not protected PDF/export `route.ts`; substitutes one UUID for all dynamic parameters; accepts 405. Its positive control is aggregate, not per target (`:117–126`). After the first session revocation, later probes largely test anonymous rejection. Prior feature-specific support/partner assertions removed in R18 were not restored as feature-specific tests; the new sweep replaces only part of that lost coverage.

Additional weak assertions: `tests/history-staging-rules.int.test.ts:174–178` matches an empty object shape and excludes a client-name canary from an aggregate that never returns client names. Separate unchanged-table/applied-batch tests are meaningful. The fuel test’s “three transfer doors” title overstates its calls. The catalogue still supplies dummy targets and accepts unrelated errors.

**CI does not run integration or e2e** (`.github/workflows/build-image.yml:21–42`). `tests/setup-db.ts:14–41` disables the reserved boundary for legacy integration tests; those cases cannot prove production-ON admission. The dedicated ON suite is useful but incomplete. No regression covers R19-03–12’s specific remaining counterexamples.

## 5. Real-data gates

All states agree with `docs/REAL-DATA-GATES.md:3,7–18`. Closing evidence must identify the approved release or disposable rehearsal.

| Gate | State | Evidence still required |
| --- | --- | --- |
| G1 Artifact/deployment identity | OPEN | Reviewed commit → approved digest/platform provenance; pinned bases; actual image contents, registry privacy and completed app/ops identity on the host. Docker-stub tests are not an executed disposable upgrade. |
| G2 Roles/privacy | OPEN | Close R19-01/02; applied ACL/owner catalogue for app/auth, all business schemas and real valid targets; production-ON role matrix across pages, API methods, RSC, bulk, audit, PDFs/downloads/exports; migration rehearsal through 0223. |
| G3 Historical information/purpose | OPEN | Historical mismatch inventory/repair, affiliation and timing-purpose approval. Add explicit retention/erasure for discarded staging labels/keys, quarantine raw/fixed cells, rolled-back history, backups and pre-0223 raw audit. Rollback retains them; owner-only access is not a retention policy (`0215_history_import.sql:180–196`, `history-import.ts:664–688`). |
| G4 Dispatch integrity | OPEN | Shared cross-plant resources, overlap/override and start/report/cancel/reassign/postpone race/recovery rehearsal. |
| G5 Phone session | OPEN | R19-04/05 plus supported-device replay/rebind/cross-account and two-tab timeout/abort/reload evidence. Device fencing locks the device row, not joined user/driver rows (`0222_field_session_fence.sql:19–25`); test account changes during an admitted transaction, not only before the next one. The test titled released-phone includes only relogin/disabled cases (`tests/r18-05-session-fence.int.test.ts:111–129`). |
| G6 Phone storage | OPEN | R19-06; both stores/notices through quota refusal, blocked upgrades, lease expiry, aborts/late copies, reload and handover on supported phones. Fake IndexedDB cannot close this gate. |
| G7 Import semantics | OPEN | R19-03/08/09; formula/header/CSV/XML ambiguity, complete authoritative package parts, coordinate bounds, opening-date/mapping/legacy replay races, accountant date/unit reconciliation and Decision 208 acceptance. |
| G8 Import auth/outcome/recovery | OPEN | R19-07/07; actual CLI competing claims/account changes/restarts, lost commit acknowledgement/process death/cleanup failure, complete rollback inventories including later-used clients. Stage-before-step-up policy and reports/diagnostics must remain accepted and free of unintended values. |
| G9 Financial/legal documents | OPEN | R19-11; independent release renders/image decoding, print/viewer and legal issuance acceptance; accountant reconciliation of admitted/skipped rows, parties, dates, quantities, amounts and document identifiers. |
| G10 Maintenance/recovery | OPEN | R19-12; real multiprocess crash/stall recovery, pre-rebrand retirement, fresh/failed startup, seed/reset and same-host database/filestore/key restore. |
| G11 Host/credentials | OPEN | Actual login/mount/app/ops/backup separation, applied privilege memberships, permissions/secrets, publishers/listeners, TLS/proxy-hop trust and restart behavior. |
| G12 Product/external acceptance | OPEN | Role/fr/ar/mobile/CSP/module-off walkthrough, training/exposure/brand and operational approvals, owner checklist signoff. Add release enforcement/evidence for integration/e2e, currently absent from CI. |

A stolen, still-live phone bearer token authorizes assigned contact/day access and permitted taps/emergencies/acknowledgements/photos. Replay keys do not prevent new-key actions; the admitted-request expiry gap is R19-05. Login IP throttling does not limit these authenticated operations. Its changed boundary showed no additional issue; trusted ingress configuration remains G11.

## 6. Verification limits

No app, tests, migrations, Docker jobs/builds, PDF/image decoders, live database or network service were run. No real workbook or company data was inspected. Only this report was written. Source assertions and interleavings above are not runtime reproductions.

Could not verify installed function/ACL/ownership state, every historical tuple, measurable timing differences, phone response ordering/storage behavior, actual built-image contents/provenance, host controls, CI/test-run claims or operational/legal acceptance. Auth-login credential doors are reviewed as trusted backend capabilities; compromise of that login is broader than a stolen phone token. Existing synthetic test claims do not close any real-data gate.
