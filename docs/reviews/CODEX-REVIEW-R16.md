# Independent security review R16 — KAYAS rebrand/training delta

Date: 2026-11-09. Confirmed checked-out HEAD: **`42dc00c24073dc50c77c033a295e4c1711089432`** (`git rev-parse HEAD` after successful detached checkout). Baseline: R15b `f9a4135b8a215d3cedfce704f35e39942476996e`.

**Verdict: conditional GO for a fresh, supervised, wholly fictitious local exercise on one Mac; NO-GO for real data.** The supplied image digest is verified as published by the exact-commit CI run, but its local pull/use is not verified. A new PDF legal-identity regression must be fixed before relying on the documents for real business. None of the 13 R15b findings is closed by this delta.

Scope: `bca08ed`, `5030775`, `5e51f8d`, `57ccc5d`, `07da349`, `42dc00c`, as returned by `git log f9a4135..42dc00c`. No UI-polish review. All implementation references below refer to confirmed HEAD.

The review fetched origin and checked out the requested commit. Git initially refused to overwrite seven untracked prior-review reports. After the user said to continue in response to the preservation proposal, those reports were moved intact to `/private/tmp/kayas-r16-prior-reviews.wY4rk0/`; no force checkout was used. No sibling repository file was opened; the requested origin fetch reported a local remote. No `.env*`, backups, generated accounts, keys, private-training or untracked brand material was read. The requested report is the only new review output in the checkout. Application code was not edited. No migrations or database writes were performed.

“Verified in source” means inspected committed code/configuration; “inference” is a source-derived, unexecuted failure scenario. Deployment, image provenance, runtime tests and legal/asset ownership claims require separate evidence and are identified explicitly below.

## Findings

**One high, three medium, one low.** No new remote authentication/RBAC bypass or secret disclosure was established. These are source findings and source-derived scenarios, not executed exploits. R16-03 is an inherited provenance gap identified in this review; the other findings concern the rebrand delta or its upgrade procedure.

### R16-01 — HIGH — legal identity can be clipped from issued PDFs

**File:line / evidence (verified in source):** `src/modules/ledger/pdf/documents.ts:23-27` removes the former wrapped company header and supplies only `legalFooter`; `src/modules/operations/pdf/delivery-note-pdf.ts:10-13` does the same for BLs. `src/modules/ledger/domain/company.ts:24-35,76-81` accepts legal names up to 200 characters and addresses up to 300, then joins legal name/form, ICE, RC and address into one line. `src/lib/pdf/pdf.ts:261-264` centers that line at size 7 without wrapping, measuring against available width, or rejecting overflow. It can start at a negative X coordinate and extend past the page. The old header used `PdfLayout.paragraph`, which wrapped these values. The new extracted-text tests use a short profile (`scripts/brand-pdf.test.ts:81-87`); text extraction alone would still find off-page strings.

**Failure scenario — inference:** an owner enters a valid long legal company name and full address. An invoice, BL or statement puts its sole seller-identity block outside the visible page; parts of the legal name/address/registrations are lost on viewing or printing even though PDF text extraction finds them. This is a document-integrity regression, not a cosmetic preference. Seller ICE is a required invoice identity field in the DGI's [official explanation of CGI article 145-VIII](https://www.finances.gov.ma/Publication/dgi/2016/note_circulaire_726_2016.pdf); the rebrand must preserve readable legal identification.

**Correction / suggested test:** wrap legal fields within a fixed footer box or retain a wrapped legal header, reserve the resulting height and refuse overflow. Render all three document kinds with short and maximum-length valid profiles, long unbroken words, all registrations and optional RIB, one and multiple pages. Verify every legal field's visible page bounds and legibility, not just its presence in extracted text. Also test missing profile and non-WinAnsi legal names; these latter limitations were not introduced by this delta.

### R16-02 — MEDIUM — the legacy-photo deletion claim treats blocked/error as successful erasure

**File:line / evidence (verified in source):** `src/modules/field/ui/photo-queue.ts:28-44` switches to `kayas-field`, stops reading `belgobeton-field` and resolves `deleteLegacyPhotoStore()` on success, error, blocked and synchronous exception alike. `:89-94` awaits that result before the new-store wipe. `src/modules/field/ui/offline-store.ts:42-48` further suppresses wipe failure. The earlier store's open connections were never closed by the queue helper (`f9a4135:src/modules/field/ui/photo-queue.ts:31-46`); the new helper still does not close its connections (`42dc00c:.../photo-queue.ts:47-62`). The new fixture explicitly closes its legacy connection before deletion (`legacy-storage.test.ts:17-19`), so it does not exercise blocked deletion. Decision 204 and `docs/BRAND-KAYAS.md:26` claim every wipe deletes the old database.

**Failure scenario — inference:** an old page keeps an IndexedDB connection open while a new KAYAS page signs out. The old database deletion is blocked; the new code resolves cleanup as though it finished, while the old photo rows remain available to the old page. Closing that page may eventually permit deletion, but is not guaranteed by this promise. Separately, pending legacy photos are invisible to new queue counts and are discarded wholesale on a later successful wipe, rather than migrated or included in the pending-work confirmation. This extends R15b's erasure/recovery qualifications across the rebrand boundary; it does not establish a foreign-trip server upload.

**Correction / suggested test:** make deletion outcome explicit, close old connections on version change, and require old pages to close before accepting migration/erasure. Decide and disclose migration versus intentional discard of unsent photos. In a real browser, hold a legacy connection open, sign out in a new page, verify durable rows after blocked/error outcomes, then close the old page and verify actual completion. Exercise same-account and different-account pending-photo cases. Do not count `onblocked` as proof of deletion.

### R16-03 — MEDIUM — digest selection is pinned, but training startup does not enforce a digest

**File:line / evidence (verified in source):** `scripts/training/pick-image.sh:10-29` selects a successful exact-commit workflow and compares the logged commit. Its reference pattern requires the right package suffix and 64 characters, but not hexadecimal characters or the exact repository owner. More materially, `scripts/training/init-env.sh:11,27` accepts arbitrary `APP_IMAGE`; `docker-compose.training.yml:36,80` accepts it for app and ops; `scripts/training-up.sh:13-21` pulls/uses it without revalidating the digest or commit. This gap already existed at R15b; the delta changes the package name, not those admission semantics.

**Failure scenario — inference:** an operator uses a mutable tag instead of the documented helper, or leaves a tag in an existing training configuration. `training-up.sh` pulls a different artifact on a later start and runs its privileged ops scripts, although the checkout was independently reviewed. The successful helper path is sound for the inspected CI run; it does not make every startup exact-commit deployment.

**Correction / suggested test:** validate `registry/expected-owner/kayas@sha256:<64 lowercase hex>` before any pull, bootstrap or seed, and verify the accepted commit/digest association at the deployment boundary. Refuse tags, malformed hashes and unexpected packages in source-level stub tests. Demonstrate app and ops running the same accepted digest via safe runtime metadata. The supplied digest's successful publication is verified below; its local pull/use is not.

### R16-04 — MEDIUM — the renamed deployment is not a state migration

**File:line / evidence (verified in source):** `docker-compose.training.yml:13,102-106` changes the project to `kayas-training`, changing default named-volume identities; `docker-compose.prod.yml:8` similarly changes the production project. `src/lib/training.ts:4-7` recognizes only `formation.kayas.invalid`, and unchanged `src/modules/platform-security/auth/session-gate.ts:68-77` gives the password-only training exception only to that recognized domain. Existing seeded databases return early without rewriting accounts (`scripts/seed-training.ts:220-221`). The ordinary update instructions still say update APP_IMAGE and run startup (`docs/checkpoints/CP-TRAINING-IMAC-FR.md:95`; English guide `:111`), without a rebrand-specific stop/state/account transition.

**Failure scenario — inference:** a supervisor follows the ordinary upgrade instructions on an old installation. Default Compose naming selects fresh KAYAS volumes rather than the old training database/accounts/filestore; earlier exercises and credentials appear to disappear, and an old container may still own the published port. If the operator deliberately retains the old volumes/project name instead, old `formation.beton.invalid` accounts no longer receive the training exception and are redirected to mandatory 2FA enrolment. Neither behavior is an authorization bypass, and the old volumes are not deleted by this rename; it is an availability/recovery and truthful-upgrade gap. Blindly applying the same project rename to a stateful production deployment is not accepted.

**Correction / suggested test:** specify either a fresh fictitious deployment with explicit retirement of the old stack, or a reviewed migration preserving database, filestore, credentials and account eligibility. Never infer safety from project naming or rewrite actual legal identities to match a product name. Rehearse both a genuinely fresh training install and a pre-rebrand upgrade on disposable fictitious storage; verify old-stack closure, explicit volume selection, account behavior and recovery. No such migration was run here.

### R16-05 — LOW — visible training material still contradicts the completed-rebrand claim

**File:line / evidence (verified source/artifact):** `docs/checkpoints/CP-TRAINING.md:65` still says the helper prints a `.../belgobeton@sha256:...` image, although it now accepts `/kayas`. The committed `docs/training/screens/admin-users.png` was inspected and still visibly says BELGOBETON and shows the old training domains. `git diff f9a4135..42dc00c -- docs/training/screens` is empty: the screenshot set was not refreshed. The guides also describe acceptance through 0121 (`CP-TRAINING.md:138`; French guide `:102`), while privacy migration 0122 is present in the target. These are not the intentionally deferred database-role/HKDF names.

**Failure scenario — inference:** a trainer distributes the current cards/screenshots or follows the image example and teaches the old identity/account format, or treats the older migration inventory as current. The brand guard scans text and skips PNGs (`scripts/brand-guard.test.ts:19,23-25,167-178`), so passing it cannot establish complete visible rebranding.

**Correction / suggested test:** correct the image example and inventory; label retained historical screenshots explicitly or regenerate them from the accepted fictitious artifact. Inspect the distributed material's pixels and current role/account links. Do not rename applied migrations or DB roles to remove intentional internal names.

## Security and training controls

**Verified in source/diff:** no changes to applied SQL migrations/RLS, permission registry, table-access registry, audit-chain implementation, money arithmetic, origin/CSRF enforcement, proxy/security-header policy or login-guard implementation. `src/modules/platform-security/auth/options.ts:58-71` keeps `bb`, explicit session-cookie naming, Strict/HttpOnly/Secure/path attributes and factor lockout; only the issuer label changes. `domain/totp-qr.ts:3,16-19` changes the matching issuer/label together and still validates the URI/account locally. Existing TOTP secrets, step claims, factor freshness and account eligibility logic are not changed. Compatibility of real enrolled authenticator accounts is an inference from unchanged secrets/verification, not a browser test performed here.

The production CSP remains nonce-based for scripts/styles, with self-only fonts and no production `unsafe-inline`/`unsafe-eval` (`src/lib/security-headers.ts:9-29`). The final Brand component uses fixed local SVG URLs, HTML width/height attributes and a closed padding-class table (`src/ui/brand.tsx:3-14,23-43`), so the rebrand does not justify a CSP relaxation. Fonts are local CSS resources (`src/app/globals.css:11-23`); the logo is a static image, not raw HTML supplied by a user. PDF route changes only replace the legal-mention formatter; authorization, document-copy consumption, audit export and private/no-store download headers remain (`src/app/pdf-response.ts:8-15`). No new RBAC/2FA/RLS weakening was found in these changes. The unchanged local `TRUSTED_PROXY_HOPS=1` setting (`docker-compose.training.yml:48-49`) still does not establish trustworthy per-IP identity when no proxy exists; this was already documented in decision 192.

**Training script inspection (not execution):**

| Component | Verified behavior and qualification |
|---|---|
| `pick-image.sh:10-29` | Exact checkout SHA, successful workflow lookup, logged-SHA equality and digest-shaped reference; source can be dirty with a warning, and the helper's use is not enforced at startup (R16-03). |
| `init-env.sh:12-23,49-59` | Refuses existing files/symlinks, exclusive creation, umask 077, fresh cryptographic randomness, 0600 files and partial-attempt cleanup. Secrets are redirected into the two files, with a completion message rather than values. No generated file was opened. `APP_IMAGE`/base URL are operator inputs, not independently certified deployment metadata. |
| `show-accounts.sh:10-48` | No argument prints names; a selector must match exactly one label/login before its block is printed. `--all` intentionally prints all credentials with a warning. This is an authorized in-person credential display, not a promise that all invocations are secret-free. The complete file traverses the local container output into the filter; terminal recording/centralized logging behavior was not inspected. |
| `dc.sh:3-6`, `ops.sh:3-7` | Forward explicit training configuration and run privileged maintenance scripts in ops. They do not weaken the scripts' mode checks. They remain trusted operator tools, not an untrusted-user authorization boundary; a general compose wrapper can expose configuration if the operator deliberately requests it. |
| `training-up.sh:13-21,29-40` | Pulls, prepares a private accounts volume, bootstraps/migrates/seeds, then starts the app. It does not itself verify publisher absence and says so. No part of it was run. |
| `docker-compose.training.yml:39-55,78-95` | App/ops force training=true, real-data=false, simulation=false; app also forces test/unmarked escape off. App mounts filestore, not the credentials volume or maintenance environment; accounts belong to ops. Loopback app port only and no DB host port. The retained public proxy profile is outside this acceptance policy. |

`src/lib/env.ts:181-228`, `src/lib/training.ts:21-30` and `src/modules/importer/domain/guard.ts:15-24` retain mode, completed-marker, outbound/provider and importer refusals. Seed/reset still reject real-data/production targets (`scripts/seed-training.ts:190-199`; `reset-training.ts:18-41`). **These are configuration/target safeguards, not content provenance:** the UI cannot determine whether an operator manually types a real person's information into a marked training database. Fictitious-only use remains an operating condition; a marker cannot certify all future entries.

**Secrets/log boundary:** inspected tracked source changes, asset metadata and new-file paths revealed no new real private key, access token or generated credential file. No tracked backup/key/log artifact was identified by the filename inventory used for this review. Test/example data are synthetic; literal test credentials are not deployment-secret evidence. `.dockerignore:6-24` continues to exclude runtime environments, logs, backups, keys, imports and generated accounts from the image context; no exclusion was weakened in the delta. This is not a forensic certification of every binary, every historic Git object, the excluded environment templates/files, Docker logs, or the installed image layers. The CI log read was restricted to the digest line; no runtime/application log was opened.

## Branding, assets and legal documents

**Completeness:** the current text UI, message catalogs, manifests, notification title, TOTP issuer, package/image name and PDF producer are KAYAS. Remaining database/role names `belgobeton_*`, applied migration text, repository/local-folder names, the field-session HKDF context (`src/modules/field/service/session.ts:18`), import advisory-lock key (`src/modules/importer/service/workbook-import.ts:85`), `bb` cookies/localStorage/cache names and delete-only legacy DB reference are explicitly deferred in `docs/BRAND-KAYAS.md:28-30`. Keeping those security/state identifiers stable is appropriate; they are not product-label defects. The old training domain is a changed behavioral input, not just display text (R16-04). Retained historical screenshots and one current image example are genuine visible leftovers (R16-05). A registered legal company name must remain the actual owner-supplied name even if it differs from the app's product brand.

**Fonts:** the two bundled TTFs are self-hosted, and both complete OFL texts with copyright notices are present next to them; `THIRD_PARTY_NOTICES.md:3-15` explains the substitution. Read-only SHA-256 computation matched the pinned package hashes (`docs/brand/KAYAS-FLUX-TRACE-README.md:124-131`):

| Font | SHA-256 of inspected bundled bytes |
|---|---|
| Inter | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` |
| Noto Naskh Arabic | `67b5a525a661b607971fbd3f96a81b89d3a768e74534fca84f18ac97e6fab72f` |

The upstream copyright/family/OFL notices were checked against the primary [Inter license](https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt) and [Noto Naskh Arabic license](https://raw.githubusercontent.com/google/fonts/main/ofl/notonaskharabic/OFL.txt); OFL permits bundling/redistribution subject to retaining its notices and terms. No Apple font binary is introduced in the tracked delta. Renaming package filenames/CSS family aliases is disclosed; these are substitutes, not the guide's Helvetica Neue/Geeza Pro or metric-identical versions. The local hashes establish exact bundled bytes, not an independent binary comparison against a fresh upstream download. These fonts are **copyrighted and licensed**, not copyright-free.

**Logo/assets honesty:** `docs/BRAND-KAYAS.md:5-13,95-97`, the trace README `:8-17,133-140` and decision 204 disclose generated-raster origin, traced vectors, absent original vector master, substitution fonts and unperformed name/similarity/ownership clearance. The SVGs inspected are local path artwork; no added external script/image dependency was found in that surface. No guide photos are added to the product in this delta. There is no source evidence establishing infringement, but equally **no evidence establishing exclusive ownership or that every logo/icon is cleared for public/commercial use**. AI generation and tracing are not rights clearance. Do not turn this source review into an ownership certificate; retain the disclosed external clearance gate before public branding, vehicle/print use or registration. Untracked incoming brand packages and the sibling repository were not inspected.

**PDF legal/money assessment:** invoice number/date, client ICE when present, due date/term and the distinct HT/TVA/TTC amounts remain in `src/modules/ledger/pdf/documents.ts:31-81`; statement balances still use stored centimes (`:161-206`); BL content remains quantities/identity without prices (`src/modules/operations/pdf/delivery-note-pdf.ts:15-24`). `src/lib/money.ts:3-18,21-42` remains integer-centime/safe-integer/BigInt arithmetic; no financial calculation was changed by the brand colors or vector transforms. PDF `/Producer` is KAYAS; no Apple font is embedded by the PDF writer, which still references the PDF base-font resources (`src/lib/pdf/pdf.ts:249-251`).

The existing invoice default of 60 days, maximum ordinary agreed term of 120 days and stored term wording were not changed (`src/modules/ledger/domain/invoice.ts:25-37`; `service/invoice-service.ts:364-372`). That ordinary rule matches the Ministry's [official payment-deadlines report, law 69-21 overview](https://www.finances.gov.ma/Publication/depp/2024/Rap-An-ODP-26-07-2024.pdf). It does not by itself establish the company's applicability, an agreement for a non-default term, sector exceptions, correct invoice issuance dates or every tax-invoice mention. Owner-supplied legal details remain configuration, with an explicit missing-profile placeholder rather than invented registrations (`company.ts:69-81`). **The documents cannot be accepted as generally legally correct at this commit because R16-01 can remove those details from the visible page.**

No PDF generator, test or renderer was run. No layout screenshot was produced. Full current tax/legal compliance and actual company registrations were not certified: the Ministry's 2026 CGI listing was found, but its PDF timed out through the browsing tool; the official older DGI ICE explanation and current Ministry payment-deadline material support only the specific points cited above. Actual buyer/seller details, rate/term applicability and readable real-document output require owner/accountant acceptance before real use.

## Image provenance

**Verified in source:** `.github/workflows/build-image.yml:21-38` makes the image job depend on lint, types and unit checks; `:44-63` checks out the workflow commit and builds/pushes **linux/amd64**, with provenance enabled and a commit-specific tag; `:77-78` emits the digest and full commit association. Source scanning alone cannot prove that a run or a pull occurred.

**Verified independently through read-only GitHub metadata/log output:** [successful workflow run 42541916756](https://github.com/aliescoobs-sudo/beton/actions/runs/42541916756) reports `headSha=42dc00c24073dc50c77c033a295e4c1711089432`, completed/success. The image job's final output at **2026-11-09 00:53:18 UTC** is:

```text
IMAGE_REF=ghcr.io/aliescoobs-sudo/kayas@sha256:d32a06b32cca9ca849f20c3ab110f401a5edfe37f1beb8d422064607f8d8cd5b COMMIT=42dc00c24073dc50c77c033a295e4c1711089432
```

This exactly matches the requested digest. GitHub run status and this narrow log line were read; CI was not rerun. This is evidence of **CI publication**, not independent verification of the registry's attestation contents, package privacy, a local pull, the local platform manifest/image ID, or a running app/ops container. No Docker operation or local secret configuration was inspected. The claim that the Mac pulled/runs this digest remains a supplied claim until safe Docker metadata establishes it. R16-03 qualifies enforcement outside the documented helper path.

## R15b disposition

This is a delta disposition, not a rerun of the earlier exploits. **None closed.** Git comparison establishes that the relevant importer/dispatch/SQL/session/seed-lock logic is unchanged except the new legacy-photo-store behavior and cosmetic text/class changes.

| R15b finding | Effect of the six commits | Target evidence |
|---|---|---|
| R15B-01 reconstructed named timings | Unchanged/open | `trip-service.ts:74-121`, `db/migrations/0119_dispatch_serialization.sql:8-15`, `0122_trip_tap_read_scope.sql:10-20`; no permission/RLS change. |
| R15B-02 failed logout/reload | Unchanged/open | `src/modules/field/ui/field-session.ts:227-251`; logout/cookie lifecycle unchanged. |
| R15B-03 cross-page photo cutoffs | Unchanged/open | `src/modules/field/ui/photo-queue.ts:21-25,108` retains the per-module wall-clock sequence. |
| R15B-04 request success versus IndexedDB commit/cleanup | Remains open; erasure assurance worsened at the new legacy boundary | `photo-queue.ts:56-62,70-81,116`; R16-02 adds blocked/error-as-success whole-store deletion. No transaction-completion fix. |
| R15B-05 reassignment/adjacent-day overlaps | Unchanged/open | `src/modules/operations/service/dispatch-service.ts:407-416,513-535`; service unchanged. |
| R15B-06 historical operational explanations | Unchanged/open | Same plan/cancellation read paths and `0120_performance_audit_scope.sql`; no history rewrite/scope change. |
| R15B-07 missing-role definer writes | Unchanged/open | `db/migrations/0118_trip_timing.sql:276-305`; no SQL change. |
| R15B-08 alternate XML calendar syntax | Unchanged/open | `src/modules/importer/domain/sheet.ts:134-140,258-261`. |
| R15B-09 ambiguous financial party names | Unchanged/open | `src/modules/importer/service/importers.ts:689-700,794-824`. |
| R15B-10 byte-only import idempotency | Unchanged/open | `src/modules/importer/service/workbook-import.ts:196-202,284-295`. |
| R15B-11 contradictory opening date | Unchanged/open | `service/importers.ts:791-792,854-856` under importer. |
| R15B-12 incomplete rollback inventory | Unchanged/open | `service/workbook-import.ts:381-413` under importer. |
| R15B-13 reusable seed-lock epochs | Unchanged/open | `scripts/training-lib.ts:353-368,402-406`; only its credentials-file title changes. |

No previous runtime-evidence requirement is satisfied merely by this rebrand, new unit assertions, or the existence of a green image build. In particular the importer remains an unaccepted real-data gate and the driver timing purpose/access/retention decision remains unresolved.

## Verdicts and missing evidence

**(a) Supervised fictitious local training on one Mac: conditional GO for a fresh accepted deployment.** Use the exact published digest above for both app and ops; establish the actual running metadata without exposing secrets. Establish fresh dedicated fictitious database/accounts/filestore volumes and no leftover old app, tunnel, reverse proxy, public profile or host DB port. The project rename is not that evidence. Follow the R15b restrictions: one maintenance operator, no overlapping/resumable seed/reset, one dispatcher, one browser profile per fictitious identity, close old pages before handover and stop stuck work. Use only synthetic images and records; never direct physical deliveries from the exercise. Close old pre-rebrand tabs and explicitly reconcile/discard pending synthetic photos. Every training document must retain its specimen marking. Existing-volume upgrades need the R16-04 procedure first. These are conditions, not host facts established by this review.

**(b) Real data: NO-GO. Importer as a real-data gate: NO-GO.** The rebrand does not close R15b's importer, privacy, dispatch, logout/storage or maintenance gates; R16-01 adds a real-document integrity regression. Brand ownership/clearance and full company/legal document acceptance also remain unestablished. Do not use a product rename, green unit build or digest publication as a production-readiness decision.

Runtime/acceptance evidence still missing:

1. Exact app/ops running-image/digest/platform metadata, verified registry privacy and artifact/provenance verification; local pull/run is not proved by the CI log. No Docker command was executed here.
2. Fresh-volume provenance and complete migration inventory including 0122/required finance migrations, actual mode/credential/mount isolation, publisher absence, FileVault/Keychain/credential handling and same-host full recovery. No environment, generated accounts, backup or key file was inspected.
3. Real-browser legacy-IDB blocked/error deletion, pending-photo migration/discard, transaction-commit failures and all inherited logout/cross-page cases. The existing fake test closes the connection that would trigger the new failure.
4. Rendered invoice/BL/statement legal-field visibility for maximum valid profiles and multi-page data; actual tax identity, ICE/RC/IF, TVA, legal terms and accountant reconciliation. Amount-format/source assertions do not replace visible document acceptance.
5. Safe synthetic upgrade rehearsal for project/volume/domain renames; current training-material and navigation walkthrough; current primary legal review and brand/name/asset rights clearance before external use.
6. All outstanding R15b synthetic production-mode importer/rollback/TOTP/concurrency, dispatch privacy/overlap, seed-lock and general production security/recovery acceptance. No app, tests, seeds, migration, database write, deployment or image pull was run by this reviewer.

Review delivery: `docs/reviews/CODEX-REVIEW-R16.md` in `/Users/macplanet/BELGOBETON-finance`, detached at the full target hash recorded above. The report is not committed and no application file was edited.
