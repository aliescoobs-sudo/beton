# CP-PROD-PLAN: the production build (R1 to R10)

Written 2026-11-02, before any code. Source of truth: [REQUIREMENTS-V1.md](../REQUIREMENTS-V1.md). Starting point: `main` at `44b5732` (pilot, fake data, 3442 tests, 140 e2e). The security rules of CLAUDE.md override everything: no weakening of RBAC, RLS, 2FA, audit log or encryption; money by deterministic code only, integer centimes; no hard delete of financial records; no AI action without a human confirmation; pseudonymize before any AI call; secrets only in the environment. The pilot's "fake data only" rule is replaced by `REAL_DATA` mode (R9), with the CNDP declaration filed before any real personal data is entered (D134).

Secret scan before this plan: gitleaks 8.30.1, 194 commits, **no leaks** (`.logs/gitleaks-history.json`). The working tree scan finds hits only in git-ignored build caches (`.next*`) and the git-ignored `.env.local` and `.env.ops`; none is tracked.

## Method
- One task per commit. Each commit runs lint (eslint + prettier), typecheck, unit and integration tests, the production build and the e2e specs of its own screens. The FULL e2e suite runs once, at the end of Batch A, one worker, on an awake machine (`caffeinate`). Logs in `./.logs/`.
- Every money and visibility rule is enforced in the database (RLS, column grants, definer functions); the exposure test is extended for every new role and screen.
- Migrations of this plan use **0078 to 0199**. 0200 and above belong to Codex (finance). `src/modules/finance` is never created here.
- Each module ships behind its own flag (`MODULE_<NAME>_ENABLED`, parameters in the database, read by one helper). Off means the entry points do not render and the endpoints answer 404. A late module stays off and never blocks the rest.

## Module flags
| Flag | Task | Default | Switched on when |
|---|---|---|---|
| `plants` | R1 | on | acceptance tests pass on the server |
| `roles_v1` | R2 | on | idem |
| `approvals` | R3 | on | idem |
| `driver_pwa` | R4 | off | idem, after the driver interview of 3 Nov |
| `notifications` | R5 | off | Batch B, done |
| `cancellations` | R6 | off | Batch B |
| `documents_v1` | R7 | off | Batch B |
| `darija` | R8 | off | Batch B |
| `assistant_det` | R10 | off | Batch B |
| `finance` | Codex | off | Codex, owner/app_admin only |
| `client_portal`, `supplier_portal` | R2 defines, later builds | **off, last** | independent security review |

## Mapping of REQUIREMENTS-V1 to tasks
| § | Subject | Task | Flag | Notes |
|---|---|---|---|---|
| 0 | Phase, timeline, flags, hard limits | R9 (+ all) | all | REAL_DATA, flags helper, hard limits tested |
| 1 | Company, two plants, no precast | R1 | plants | plant is a first-class dimension |
| 2 | Fleet, pumps, external trucks, fuel, stopped trucks | R1 | plants | statuses, decision field, pump not tied to a plant |
| 3.1 to 3.8 | Roles and money visibility | R2 | roles_v1 | accountant exports are Codex's |
| 3.9, 3.10 | Portals | R2 (definition only) | off | roles exist, no screen, flag off |
| 3.11 | partner unused, support kept | R2 | roles_v1 | |
| 4 | Provisional prices, invoice block | R3 | approvals | |
| 5 | Terms, credit limit | R3 | approvals | terms templates editable by office_sales |
| 6 | Stock per plant, thresholds, receipt flow | R1 | plants | two-step receipt in R1; plant interview 3 Nov refines |
| 7 | Driver and pump PWA | R4 | driver_pwa | |
| 8 | Seven cancellation cases | R6 | cancellations | Batch B |
| 9 | Documents | R7 | documents_v1 | Batch B; invoice numbering needs the last 2026 number |
| 10 | Finance | Codex | finance | reads through the public indexes below |
| 11 | Assistant | R10 | assistant_det | Batch B; no external LLM on real data |
| 12 | Approvals inbox | R3 | approvals | |
| 13 | Notifications, languages | R5, R8 | notifications, darija | Batch B |
| 14 | Hosting, CNDP, import | R9 | (REAL_DATA) | provider-neutral; CNDP is a gate, not code |
| 15 | Open points | tracked in DECISIONS | | |

## Tasks and checklist
Status: `[ ]` to do, `[x]` done, `[~]` partial.

### Batch A
- [x] **R1 Plants and fleet** (§1, §2, §6) — done 2026-11-02, migrations 0078 to 0081, AC-PROD-01 to 07 proved by `tests/plants.int.test.ts`, `src/modules/operations/domain/stock.test.ts`, e2e `plants.spec.ts`. Mechanism: a row learns its plant by a database trigger (explicit, parent document, request plant context, or the only active plant; with two active plants it is refused). Pump trucks and hired trucks have no plant. Not in R1 (recorded): the order and purchase forms do not yet have a plant picker (a plant manager's plant will come from R2 through `inPlant`); the external truck rate is money and is finance's. Plant table (Tétouan, Chefchaouen); plant on stock, stock movements, thresholds, recipes (per plant), orders, dispatch, loads, trips, receipts and fuel tank; stats per plant and in total; truck statuses (active, stopped breakdown with a decision field: repair and use, repair then sell, sell as is), truck capacity and plant, mobile pump trucks (no plant), external trucks with a configurable pay basis (per trip, per m³, per day); two-step receipt (plant confirms, office_purchases confirms and enters details, then stock goes up); reorder threshold per component and plant from lead time and average daily consumption.
- [x] **R2 Roles** (§3) — done 2026-11-02, migration 0082, AC-PROD-08 to 14 proved by `tests/roles-v1.int.test.ts`, the permission matrix test, `tests/user-admin.int.test.ts` (D139). Not done: plant scope on three older definer reads; seeing the sales/purchases split in the UI menus beyond the permission matrix. `app_admin` with its mitigations (all actions audited and visible to the owner, step-up for sensitive actions, cannot touch the audit log, cannot remove or downgrade the owner); `office_sales`, `office_purchases` (balance status only: owes / does not owe, late / not late), `plant_manager` scoped to one plant by the database, `driver`, `pump_operator`, `accountant` (read invoices with amounts; no treasury); `client_portal` and `supplier_portal` defined with the flag off. Existing `office` migrates to one of the two office roles by an explicit, audited step; `partner` stays unassigned; `support` stays read-only.
- [x] **R3 Prices and approvals** (§4, §5, §12) — done 2026-11-02, migration 0083, AC-PROD-15 to 19 proved by `tests/approvals.int.test.ts` and e2e `approvals.spec.ts` (D140). Not built: credit-limit screen, other card kinds, push. Reference average price per type per plant; provisional price on new orders; invoice blocked while any line is provisional (database guard); confirm in one tap or in bulk with step-up, audited; credit limit per client and pending status for an order over it or from a client with overdue invoices (office sees "pending approval", no figure); one approvals inbox with push-ready cards (provisional prices, credit pending; the other card kinds register as later tasks add them).
- [x] **R4 Driver and pump PWA** (§7) — done 2026-11-02, migrations 0084 and 0085, AC-PROD-20 to 26 proved by `tests/field.int.test.ts`, `src/modules/field/**/*.test.ts`, e2e `driver-app.spec.ts` (D141). Behind `FIELD_APP_ENABLED`. Not done: BL photo from the phone, join instruction on the office screen, push, interview refinements. Six steps with one big button; emergency button with options by step; office instructions (continue, extra load, redirect with address, map link and acknowledgement, join); offline queue with timestamps and sync; sign-in by short PIN plus device binding; large Arabic text with icons; never a price. Pump steps: arrived, set up, pumping started, pumping ended (m³ pumped), left. Refined after the 3 Nov driver interview.
- [x] **R9 Production readiness** (§0, §14) — done 2026-11-02, AC-PROD-27 to 33 proved by `scripts/production-config.test.ts`, `tests/import.int.test.ts`, `src/modules/importer/domain/sheet.test.ts`, the backup restore run, `docs/RUNBOOK.md` (D142). Not done: cheques-in-transit and component/recipe importers, a signed audit anchor, the host. `REAL_DATA` mode (seed and simulation refuse, banner and SPÉCIMEN removed, module flags); Excel importers (clients, suppliers, products, price list, trucks, opening balances, cheques in transit) with a dry-run report that writes nothing; production Docker (app image, database on a private network only, never published to any host port); encrypted backup with a tested restore and a nightly encrypted copy pulled to an office machine (pull-based, the app host holds no key to the copy); health checks; `docs/RUNBOOK.md`; provider-neutral.
- [x] **A12 Full regression and report.** 2026-11-02: lint, typecheck, 3688 unit and integration tests pass; production build passes; full e2e, one worker, machine awake: **149 passed, 2 skipped (opt-in screenshots), 0 failed, 31.6 min** (`.logs/a12-e2e.log`). Build, then the full e2e once, one worker, awake machine. Update this file, commit, stop with a short report.

### Batch B (done 2026-11-03, one commit per task, all behind their flags, default off)
- [x] **§16.1 to §16.4** — visibility matrix, document library, scoped disclosure, assistant refuses a chosen amount (D143, D144).
- [x] **R5 Notifications** (§13) — D145, flag `NOTIFICATIONS_ENABLED`.
- [x] **R6 Cancellations and incidents** (§8) — D146, migration 0090, `tests/cancellations.int.test.ts`, flag `CANCELLATIONS_ENABLED`. Seven cases from the real state of the order, redirect or loss with the owner's policy on who decides, BL kept and marked "annulé". Not done: the driver app does not yet show the redirect address (door `driver_redirects` exists), billing the m³ unloaded of case 5, the plant manager's technical confirmation (§16.10).
- [x] **R7 Documents** (§9) — D147, migration 0091, `tests/documents-v1.int.test.ts`, flag `DOCUMENTS_V1_ENABLED`. Gate for number-bearing documents a client asks for, invoice timing parameter, numbering continues from the last number. Not done: the invoice queue does not group by the timing; the last 2026 number is to be given by the owner; the gate records and releases, it cannot intercept a print.
- [x] **R8 Darija** (§13) — D148, migration 0092, `tests/darija.int.test.ts`, flag `DARIJA_ENABLED`. Locale `ary` overlaid on Arabic, per-account language and switch. First Darija wording (driver app, notifications, cancellations) is a draft to be read by a Darija speaker.
- [x] **R10 Deterministic assistant** (§11) — D149, migration 0093, `tests/assistant-det.int.test.ts`, flag `ASSISTANT_DET_ENABLED`. Anomaly report with fixed thresholds, field surveys. Quick-question buttons already existed.
- [x] **§16.5 transfers, §16.8 order timeline, §16.9 day close** — D150, migration 0094, `tests/plant-flows.int.test.ts`, flag `TRANSFERS_ENABLED`. Not done: served-by-other-plant booking (§16.5 second bullet), fuel stock effect of a fuel transfer, fuel variance and cash per holder in the day close.
- [x] **Batch A gaps closed**: plant scope on order chain, delivery note and dispatch board (migration 0095); credit-limit screen.
- [ ] **Not started (not in this batch's list)**: §16.6 pump coordination, §16.7 receipt states, §16.10 redirect compatibility, §16.11 and §16.12 (finance, Codex).

## Acceptance criteria (AC-PROD)
Each AC has one proving test named in the table at the end of the batch.

### R1 plants and fleet
- AC-PROD-01 Two plants exist; every stock row, movement, threshold, recipe, load, trip and receipt carries a plant; a query without a plant is refused by constraint, not by convention.
- AC-PROD-02 Consumption by recipe deducts from the plant of the load only; stock of one plant never changes for a load of the other.
- AC-PROD-03 Stats (m³, orders, stock) are available per plant and in total, and the total equals the sum of the plants.
- AC-PROD-04 A stopped truck (breakdown) cannot be planned, keeps its decision field, and stays in the fleet.
- AC-PROD-05 A pump truck has no plant and can be assigned at either; an external truck's pay basis is configurable and its pay is never visible to a role without money.
- AC-PROD-06 A receipt raises stock only after both confirmations (plant, then office_purchases); either alone changes no stock.
- AC-PROD-07 The reorder threshold is derived per component and plant from the lead time and the average daily consumption, with market defaults until history is imported.

### R2 roles
- AC-PROD-08 The role list is exactly the V1 list; a role not in the matrix gets nothing (default deny).
- AC-PROD-09 Money (amounts, balances, cash, bank, P&L, loans, financing) is readable only by owner and app_admin (plus the accountant on invoices, support as D81); proven by zero rows for every other role on every money table and view.
- AC-PROD-10 office_sales and office_purchases get status only for balances ("owes / does not owe", "late / not late"); the figure is never in a response or the DOM.
- AC-PROD-11 plant_manager reads and writes only the rows of their own plant, enforced by RLS.
- AC-PROD-12 app_admin: every action audited and visible to the owner; sensitive actions need a step-up; no path to alter or delete the audit log; cannot remove or downgrade the owner (database trigger).
- AC-PROD-13 client_portal and supplier_portal exist as roles with no grants and no screen while their flag is off.
- AC-PROD-14 The exposure test covers every new role and every new screen.

### R3 prices and approvals
- AC-PROD-15 A new order takes the reference price of its type and plant as a provisional price, flagged.
- AC-PROD-16 An invoice cannot be created while any line has a provisional price (database guard, audited refusal).
- AC-PROD-17 Confirming a price is one tap per order or in bulk, with step-up, audited; profit counts confirmed prices only.
- AC-PROD-18 An order over the client's credit limit, or from a client with overdue invoices, stays pending; office sees "pending approval" and no figure.
- AC-PROD-19 One inbox lists the pending cards for owner and app_admin; each card states exactly what will happen; approval writes through the normal service with the human as actor.

### R4 driver and pump PWA
- AC-PROD-20 A driver reads only their own trips; no price or amount exists in any driver response (exposure test).
- AC-PROD-21 The six steps run in order, one tap each; the m³ unloaded is entered at step 5.
- AC-PROD-22 The emergency button offers the options of the current step and alerts office, owner and app_admin.
- AC-PROD-23 Office instructions (continue, extra load, redirect, join) reach the driver; a redirect needs an acknowledgement, recorded.
- AC-PROD-24 Taps made offline are queued with their timestamps and synced in order; a replay is idempotent.
- AC-PROD-25 Sign-in is a short PIN plus a bound device; a new device needs an approval; lockout after repeated failures.
- AC-PROD-26 The pump flow has its five steps and records the m³ pumped.

### R9 production readiness
- AC-PROD-27 With `REAL_DATA=true` the seed, the simulation and the pilot scenario refuse to run; the SPÉCIMEN marks are not printed.
- AC-PROD-28 Each importer has a dry-run that reports rows, errors and duplicates and writes nothing; a real run is one transaction, audited.
- AC-PROD-29 The production compose file publishes no database port; the database is on an internal network only (test parses the file).
- AC-PROD-30 An encrypted backup restores into a scratch database and passes `audit:verify`; the restore test is a script and is run.
- AC-PROD-31 The nightly copy is pulled by the office machine; the app host holds no private key for it.
- AC-PROD-32 Health endpoints report liveness and readiness (database, migrations) with no sensitive detail.
- AC-PROD-33 `docs/RUNBOOK.md` covers install, update, backup, restore, key rotation, incident and rollback.

## Information-visibility matrix (§16.1)
Four rights per money item, stated separately. Entering or printing never grants a balance or an aggregate. Source: `src/modules/platform-security/domain/visibility-matrix.ts` (this table is printed from it and a unit test fails when they differ); the balance column is proved in the database by `tests/visibility-matrix.int.test.ts`. D245 (T19): office_sales reads the CLIENT side and office_purchases the SUPPLIER side and the cash accounts, each audited, nothing else. Known exceptions: office_sales prints invoices with amounts; office_purchases enters supplier invoices and payments; the accountant exports HT, VAT and TTC; reference prices are visible to internal non-field roles (`public.reference_prices`).

| Item | Enters | Sees in a document | Sees balances and aggregates | Exports |
|---|---|---|---|---|
| Reference average prices (sell and buy) | owner, app_admin | owner, app_admin, office, office_sales, office_purchases, plant, plant_manager, support | — | — |
| Order and quote prices and totals | owner, app_admin, office, office_sales | owner, app_admin, office_sales, support | owner, app_admin, support | owner, app_admin, support |
| Sales invoices and avoirs | owner, app_admin, office, office_sales | owner, app_admin, office_sales, accountant, support | owner, app_admin, support | owner, app_admin, accountant, support |
| Supplier invoices and purchase prices | owner, app_admin, office, office_purchases | owner, app_admin, office_purchases, support | owner, app_admin, support | owner, app_admin, accountant, support |
| Payments in and out (cash, cheque, LCN) | owner, app_admin, office, office_sales, office_purchases | owner, app_admin, support | owner, app_admin, support | — |
| Payments in (client side: receipts, cheques, LCN) | — | owner, app_admin, support, office_sales | owner, app_admin, support, office_sales | — |
| Payments out (supplier side) | — | owner, app_admin, support, office_purchases | owner, app_admin, support, office_purchases | — |
| Client and supplier balances | — | owner, app_admin, support | owner, app_admin, support | — |
| Client balances and statements | — | owner, app_admin, support, office_sales | owner, app_admin, support, office_sales | owner, app_admin, support, office_sales |
| Supplier balances and statements | — | owner, app_admin, support, office_purchases | owner, app_admin, support, office_purchases | owner, app_admin, support, office_purchases |
| Cash accounts (the cash, never a bank account) | — | owner, app_admin, support, office_purchases | owner, app_admin, support, office_purchases | — |
| Cash, bank, treasury, forecast | owner, app_admin | owner, app_admin, support | owner, app_admin, support | — |
| Fuel purchases (amounts) | owner, app_admin | owner, app_admin, support | owner, app_admin, support | — |

## Interface for Codex (finance reads through the public indexes)
Codex works in a separate worktree, branch `codex/finance`, in `src/modules/finance`, migrations 0200 and above, and never merges into main. Finance imports only from these module indexes (`src/modules/<module>/index.ts`), never from a `service/` or `domain/` file, and never reads a table directly except through a view or function granted to it. `module-map.mjs` will list `finance: ['platform-security', 'master-data', 'ledger', 'operations', 'clock']`; that line is the only change to shared files Codex may propose, through this file.

| Finance needs | Where it reads (current public export) | Planned addition (this plan) |
|---|---|---|
| Sales (orders, invoices, avoirs, VAT per document) | `ledger`: `listInvoices`, `getInvoiceDocument`, `listAvoirs`, order and quote reads | R3 adds `price_status` (provisional/confirmed) on orders; finance reports profit on confirmed only |
| Purchases (orders, supplier invoices, matches, payables) | `ledger`: `listPurchases`, `getPurchaseDetail`, `getSupplierInvoice`, `getSupplierInvoiceMatch` | R1 adds `plant_id` on purchases and receipts |
| Cheques, LCN, cash, bank | `ledger`: instrument and money-account reads, `getStatement` family | none |
| Trucks, fuel, plants | `master-data`: truck reads; `operations`: fuel reads | R1 adds `plant_id`, truck status and decision, pump and external-truck kinds, external pay basis |
| Stats per plant | `operations`: `getVolumeAnalytics` | R1 adds a plant filter and a total |
| Roles | `platform-security`: `PERMISSIONS`, `Role` | R2 adds `app_admin` and `accountant`; finance permissions (`finance.*`) are defined by Codex in its own file and merged by the lead |

Rules for the interface: money is integer centimes; a finance read goes through the caller's own RLS context; no finance table is created before migration 0200. Where finance needs a read that does not exist, Codex asks in this file and the lead adds the export; Codex does not edit `ledger`, `operations` or `master-data`.

## Order and dependencies
```
R1 ─ R2 ─ R3 ─ R4        R9 (parallel after R1; importers need R1's plant on master data)
              └─ A12
```
R2 follows R1 because `plant_manager` scoping needs the plant column. R3 needs R2's roles. R4 needs R1 (trips per plant) and R3's emergency cards. R9 starts after R1 and finishes last.

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Splitting `office` into two roles breaks RLS policies written for `office` | High | migrate by adding both roles to every policy that lists `office`, then narrow; the table-access meta-test and the exposure test run on every commit |
| Adding `plant_id` to existing rows | High | migration derives it from existing rows (one default plant for old data, explicit and audited), never invents data; REAL_DATA starts empty |
| Scope: five tasks in one batch | High | one commit per task; a task that cannot reach its AC stays flagged off and is reported, not hidden |
| Real data on a server | High | REAL_DATA refuses seed and simulation; CNDP gate in the RUNBOOK; database never on a public network |
| Offline queue replays | Med | idempotency key per tap, server order by device timestamp, conflicts audited |
| Interview of 3 Nov changes §6 and §7 | Med | R4 built behind its flag with the step list as data, not code |

## Not finished (end of Batch A, 2026-11-02)
- **Docker image never built end to end**: `next build` was killed (exit 137, out of memory) in the Mac's 2 GB Colima VM. Build on a host with 4 GB or more; the first install on the server is the real test (RUNBOOK §3).
- **R1**: no plant picker on the order and purchase forms (a plant manager's plant comes through `inPlant`); the reference price is global, not per plant (D140); external truck rates belong to finance.
- **R2**: three older definer reads (`order_chain`, `delivery_note`, `dispatch_office`) are not plant-scoped for a plant_manager; office_sales and office_purchases share the non-money office reads (D139).
- **R3**: no screen to set a credit limit; only two of the seven inbox card kinds exist (price, credit hold); no push.
- **R4**: no BL photo from the phone, no `join` option on the office screen, no push; the 3 Nov interviews will refine steps and emergencies; billing the driver's m³ as excess is not wired.
- **R9**: importers for cheques in transit, components, recipes and history are missing; the audit anchor is not signed; the host and the CNDP declaration are open.
- Items for Ali: `docs/VISION-V3.md` was untracked in the tree and went into commit bdc408b with R1; the dev database was repaired by hand once (wrappers of migration 0082), the test databases are recreated on every run.


## Batch B end report (2026-11-03)
Migrations 0090 to 0095. Flags added: `CANCELLATIONS_ENABLED`, `DOCUMENTS_V1_ENABLED`, `DARIJA_ENABLED`, `ASSISTANT_DET_ENABLED`, `TRANSFERS_ENABLED` (all off by default, on in the e2e config). Still open from Batch A: plant picker on order and purchase forms, reference price per plant, other approval card kinds, BL photo, office `join`, importers for cheques in transit, components and recipes, Docker image build, hosting and CNDP. No new e2e spec was written for Batch B screens: they are proved by integration tests; a spec per screen is a next step.

Final regression of Batch B (2026-11-03): lint, typecheck, 3974 unit and integration tests pass; production build passes; full e2e, one worker, awake machine: **147 passed, 2 skipped, 1 failed in 30.8 min** (`.logs/e2e.log`). The failure, `payment-allocation.spec.ts:53` (office page must show no amount pattern), passes when the spec is run alone, so it depends on data left by earlier specs and is not yet explained. The first full run found a real fault of R5: the bell pushed the top bar past 375 px; fixed with a compact bell and a smaller header. A `'use server'` file may export only async functions (two parsers moved out).

## Finance interface follow-up (Codex, 2 Nov)

Implementation and validation: [CP-FINANCE.md](CP-FINANCE.md). Finance owns schema `finance`, migrations 0200–0206 and permissions in `src/modules/finance/domain/permissions.ts`. Its source reads use reviewed, role-checked SQL doors defined by those migrations, with named fields only, because the existing public APIs do not expose consumption valuation and the accountant's restricted journals in one consistent read. Please review those doors when integrating; equivalent public ledger/operations reads may replace them without widening their field sets. No ledger, operations or master-data implementation was changed.

R2 must provision app_admin/accountant and grant app_admin the ordinary `listPlants` permission. R3 must expose `sales_order.price_status='confirmed'`; until then finance excludes invoice revenue from management result and marks the report incomplete. The accountant door includes partial avoirs as well as invoice reversal documents, and exposes no treasury, balances or financing. Its provisional scope and the common module-switch helper still need the lead's integration. Resolve Drizzle journal order/timestamps with the parallel 0082–0199 migrations before any merge; the finance SQL filenames remain 0200 and above. The separate isolation commit is for this worktree, not the production host configuration.

## Batch C end report (2026-11-04)
Migrations 0096 to 0104 (finance 0200 to 0207 merged, journal re-based). Flag added: `FINANCE_ENABLED` (off). DECISIONS 151 to 159.
- **C0** the `payment-allocation.spec.ts:53` failure was test noise (a random cheque number holding "DH"), not a leak; `moneySafeSuffix()` fixes the three specs that need it.
- **C1** Codex finance merged (isolation changes undone on main), journal re-based, R2 roles and R3 confirmed price wired (0207), exposure tests extended, flag off.
- **C2** server hardening from CODEX-REVIEW-R9: one backup set (database, documents, manifest), signed pull receipt checked on restore, staged pull with freshness and alerts, key rotation sees the filestore, three secret files, `dc.sh` for every compose command, plain node in ops, `APP_DOMAIN` to Caddy, protected `FIRST_BOOT`, readiness counts migrations, CNDP transfer item for Infomaniak, GHCR workflow and deploy by digest. Not proved here: the image build end to end, the live firewall and SSH, monitoring, the workflow itself. Nothing pushed.
- **C3** plant picker; reference price per plant; BL photo from the driver's phone; redirect address and acknowledgement in the driver app; case 5 bills the m³ unloaded; importers (cheques in transit, components, recipes); receipt states; pump coordination (basic); fuel transfer with stock effect.
- Left for later: §16.10 compatibility checks, day-close fuel and cash lines, office `join` option, recipes per plant, e2e specs for the plant picker, receipts and price-per-plant screens, a variance rule between the plant's count and the office's receipt, dipstick counts.


Final regression of Batch C (2026-11-04, `.logs/final-e2e.log`): lint, typecheck, unit and integration tests and production build pass; full e2e, one worker: **153 passed, 1 failed, 2 skipped, 1 did not run in 31.9 min**. The failure, `ledger-cash.spec.ts:38` (support reads the position; office has no link and no page), was fixture pollution, not a leak: `finance.spec.ts` (merged from Codex) enrolled `cashSupport`, the same user the cash spec enrols, so the second enrolment met the TOTP prompt instead of `/enrol` and stopped before any office check. The test that did not run, `ledger-cash.spec.ts:50` (Arabic layout), is in a serial file and was skipped after the failure. Fix: `finance.spec.ts` has its own user `finSupport`. Rerun of `finance.spec.ts` and `ledger-cash.spec.ts`: 7 passed (`.logs/rerun-cash.log`), including the office no-link and 404 checks. No permission or navigation change was needed; the office checks of that spec were never reached in the failed run, and pass in the rerun.

## Batch C+ (2026-11-04): recipes per plant, receipt variance, day close, e2e
Migrations 0105 to 0107. DECISIONS 160 to 162.
- **C4.1** recipes per plant (0105): optional plant on a recette, the plant's own mix wins from its date, one database function `recette_in_force` used by the load guard and the service, plant manager reads own plant and shared mixes. Limits: projection and costing read the all-plants mix; the importer writes all-plants mixes.
- **C4.2** variance between the plant's usable count and the office receipt (0106): insert-only row per line, parameter `receipt_variance_bp` (2 %), notification above it, shown on the receipts screen.
- **C4.3** day close (0107): fuel variance lines (received fuel transfers with a litre gap; a tank below zero blocks) and cash per holder for owner and app_admin only, when finance is on. Cash is company-wide, not per plant. Dipstick counts still not built.
- **C4.4** e2e `plant-screens.spec.ts` (plant picker, receipt states with variance, price per plant); day-close cash covered in `finance.spec.ts`.
- Final regression: lint, typecheck, 4258 unit and integration tests, production build pass; full e2e, one worker, `caffeinate`: **158 passed, 2 skipped, 0 failed in 33.3 min** (`.logs/c4-final-e2e.log`).

## Batch D (final security review, `docs/reviews/CODEX-REVIEW-FINAL.md`): paused
Paused on 2026-11-04 by the lead for the training instance (T1). Done, one commit each: **F01** `4beaa39` (pump surface scoped to the plant, 0108), **F02** `2888cce` (driver offline data), **F03 + F12** `fce819c` (step-up for decisions and force-close, central policy, 0109), **F04** `d3c347d` (bootstrap file, keys/reports ownership), **F05** `3eff6bb` (deploy.sh root and rollback), **F06** `36e369f` (complete rotation registry, 0110).

**Deferred to pre-production** (not started; each needs its own commit and a test that proves it, enforced in the database and the server actions):
- ~~**F07**~~ **done** (D7 / decision 169): `MAP_LINKS_ENABLED` off by default; address as text with a copy button.
- ~~**F08**~~ **done** (decision 170, migration 0112): a client copy needs an approved request consumed by the download (own, exact document and client, 24 h, once); the internal print is unchanged.
- ~~**F09**~~ **done** (decision 171): no payment-state call for a role without balances; export for the accountant is the sales journal (purchases journal only through finance when it is on).
- ~~**F10**~~ **done** (decision 172): the environment flag is checked first on both finance endpoints.
- ~~**F11**~~ **done** (decision 173, migration 0113): attempts serialised per driver by a row lock, lock re-checked by the database before a session, new PINs 6 to 8 digits. Open: an IP-level throttle.
- ~~**§16.10 note**~~ **done** (decision 174, migration 0114): the redirect carries the destination address (typed one wins, else the site's, else refused); a guard test keeps redirects same-origin. Still open: the plant manager's technical confirmation and compatibility beyond the strength class.
The review's verdict stands for real data until these are closed: do not launch with real data; the training instance (fictitious data only, `docs/checkpoints/CP-TRAINING.md`) is not a launch.

## Batch D closed (2026-11-05)
F07 to F11, the §16.10 destination address and the `password_reset` audit action are done (decisions 169 to 175, migrations 0112 to 0115). Regression: lint, typecheck, prettier, 272 test files / 4385 tests, production build pass; full e2e, one worker, `caffeinate`: **165 passed, 2 skipped, 0 failed in 33.5 min** (`.logs/d-e2e2.log`). A first full run stalled for 3.4 h (single tests hung 3 to 15 min at the TOTP click, 12 failed, 11 did not run); the failed specs pass alone and the rerun was clean, so it was the machine, not the code. Still open: IP throttle on the driver sign-in, plant manager's technical confirmation for §16.10, `ops.sh` has no `reset-owner-*` subcommand, e2e specs for the client-copy download and the copy-address button, `FIELD_APP_ENABLED` and `FINANCE_ENABLED` stay off until the pre-production review.

## Status for the lead (2026-11-05)
- **T1 training instance: done** (commits T1.1 to T1.6, `docs/checkpoints/CP-TRAINING.md` and the French iMac guide `CP-TRAINING-IMAC-FR.md`). Guard, seed and reset, one account per role, password-only sign-in on the reserved address, banner, imports/maps/push/LLM off, compose bound to 127.0.0.1 with Caddy behind a profile for the VPS, up/down/reset/backup/set-url/funnel-check scripts. The CI image build is green on the last push. Not proved here: a start on a real Docker host, Colima, Tailscale Funnel and the nightly job on the iMac (the guide says to rehearse them once). A local training instance runs on Ali's Mac (separate database `belgobeton_training`, port 3300, `training-accounts.local.txt` at the repo root, ignored by git).
- **Batch D, deferred to pre-production:** F07 (no external map link), F08 (document copy needs an approved request), F09 (accountant invoice paths), F10 (environment flag on every finance endpoint), F11 (atomic PIN attempts, 6-digit minimum), the §16.10 note (redirect carries the destination address), and ~~**a "password reset" audit action**~~ **done** (decision 175, migration 0115): `password_reset` plus the `user:reset-owner-password` break-glass command, tested.
- **Full e2e:** not rerun since Batch D and the training work (the Mac was on battery). The last full run, 158 passed, predates them; the training spec and the driver, finance and approvals specs were run on their own and pass. Run it once on power before real data.
- The review's verdict stands for real data: do not launch with real data until Batch D is closed and the pre-production steps of the runbook are rehearsed.


## T3: fixes of the R11 review (`docs/reviews/CODEX-REVIEW-R11.md`), started 2026-11-05
- [x] **R11-01** PIN sign-in. The review was written on `52c2858`, before Batch D. Already closed by F11 (`cade9d1`, migration 0113): atomic serialised attempts per driver (row lock), the database re-checks the lock before issuing a session, new PINs 6 to 8 digits, concurrency test (24 parallel wrong PINs). **Remained and done here:** the per-IP limit on `/api/field/login` (same parameters as the office sign-in, `ipIsLocked`, 429; the IP is the entry the trusted proxy appended). Test `tests/field-ip-throttle.int.test.ts`. The forged `X-Forwarded-For` behaviour through the real Funnel is still to be verified on the iMac.
- [x] **R11-02** training admission, both ways. Boot: `TRAINING_MODE=true` now needs the training marker (a completed seed); an unmarked database, empty or not, is refused. Seed: refuses before any write a database that is not empty (accounts, parties, orders, trucks, drivers, invoices, payments) and unmarked; the marker stays the last write. The e2e training server shares the unmarked e2e database, so it alone sets `TRAINING_ALLOW_UNMARKED=true` (refused by the environment without training mode and with production or real data; a test keeps it out of the compose file and `init-env.sh`). Tests: `training.test.ts`, `training-admission.int.test.ts`, `training-config.test.ts`. A seed that fails half-way leaves an unmarked, non-empty database that is refused: remove the training volume and start again.
- [x] **R11-03** `set-url.sh` and `deploy.sh` rewrite the env file privately: `umask 077`, `mktemp` (exclusive, mode 0600, never a planted name), refuse a symlinked env file, atomic `mv`, temp removed on failure. Tests under umask 022 with a planted world-writable temp name and a symlink (`training-config.test.ts`, `server-hardening.test.ts`). `init-env.sh` already ran under `umask 077`.
- [x] **R11-04** the accounts file. The `out/` folder (mode 1777) is gone: the file lives in the Docker volume `accounts`, mounted at `/app/out`, made `0700` and owned by uid 10001 by `training-up.sh` before the seed. The seed validates the destination before any write (name `training-accounts*.local.txt`, folder ours, not a link, not writable by others, destination a regular file of ours), stages the file exclusively (`O_EXCL|O_NOFOLLOW`, 0600, fsync), renames it, and only then writes the marker; a failed credentials write stops the seed saying so, with no marker (the half-seeded database is then refused by R11-02); a failed marker removes the file again. Tests: `training-lib.test.ts`, `training-admission.int.test.ts` (three cases), `training-config.test.ts`. Not verifiable here: that the volume really starts owned by 10001 on Colima (the script chowns it explicitly; rehearse on the iMac).
- [x] **R11-05** F01 NULL plants (migration 0116): `_pump_in_scope` returns a definite boolean (`coalesce(..., false)`), so `IF NOT _pump_in_scope(NULL)` now raises for a manager in the job insert guard, `set_order_pumped`, the pump doors, the emergency instruction and the redirect candidates; `redirect_candidates` filters each candidate row with `_pump_in_scope(o.plant_id)` (a manager never gets an unassigned order, a case with no plant is refused). The owner (not bound to a plant) still sees all. Tests with NULL-plant fixtures in `pump-scope.int.test.ts` (4 cases). The original F01 is now closed.
- [x] **R11-06** F02's 18 hours are a hard limit. `savedAt` is the time the SERVER last answered and local taps no longer move it (`rewrapDay`); `judgeDay` (fresh / stale / none) runs on a 20 s timer and on every return to the page (`visibilitychange`, `pageshow`, `focus`, `online`): a day older than 5 minutes is read from the server again (so a revoked phone or account is found with no queued work), a day past 18 hours that cannot be renewed is erased and the sign-in shows, without a reload. Tests: `offline.test.ts` (clock moves), `driver-app.spec.ts` (two new e2e: a tap keeps `savedAt` and the open page crosses the limit by itself; a revoked session is found with an empty queue). Still true and documented: no local PIN lock on an unlocked phone.
- [x] **R11-07** push in training: `/api/field/push` (GET and POST) answers 404 in training mode before the session is even read; the phone page and the notifications page render no subscription action (`pushAvailable` is false in training); the environment refuses `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` with `TRAINING_MODE=true`. Tests: `training.test.ts`, `training-config.test.ts` (no VAPID in compose or `init-env.sh`), `training.spec.ts` (two e2e on the training server).
- [x] **R11-08** finance in training, real TOTP kept (no bypass, no role widened). The seed turns the finance database switch on (`configure`, provisioning like its other step-up flags). A password-only training session is refused by finance (read, write, export: `FINANCE_UNAVAILABLE`). Owner, app_admin and accountant may enrol a real authenticator voluntarily: `/enrol` now accepts a signed-in training account without one (only in training mode, only on the reserved address), and the training banner shows the link to exactly those accounts (`offersFinanceEnrolment`). Tests: `training-finance.int.test.ts` (switch on; password-only refused; after real TOTP enrolment a finance write, a report and an accountant export succeed), `training.test.ts`. Documented in CP-TRAINING.md.
- [x] **R11-09** a dump alone does not move training work: CP-TRAINING.md now says the VPS starts with a fresh seed (earlier work discarded, new credentials) and why (the dump is the database only; attachments are in the `filestore` volume; keys are per host; session tokens and hashes are in the dump), and that a restore is for the same host, files and volume. No complete relocation was rehearsed, so none is promised. Test: `training-config.test.ts` (text).
- [x] **R11-10** the iMac guides (English and French): FileVault stays ON and automatic login OFF (the cost, a manual unlock after a power cut, is stated); the Docker credential helper (`docker-credential-helper`, `"credsStore": "osxkeychain"`) is required and checked before the login and again after it (`grep -c '"auth"'` must be 0); the GHCR token stays read-only (`read:packages`); `show-accounts.sh` now lists names only and shows one trainee's block at a time (`--all` is explicit and warns), with no screenshot, redirection or terminal recording. Tests: `training-config.test.ts` (the script against a stub, the guides as text).
- [x] **R11 tail: Funnel last, real port, exact image.** The guides (English and French) now go: address learnt from Tailscale, `set-url.sh` FIRST, then `go-public.sh` (the only step that opens the Funnel: it refuses unless the app was told that very address, runs in training mode and answers its readiness check, then `tailscale funnel --bg <real APP_PORT>`), then a test of the whole path (login, write, logout) over the real HTTPS address and a check that `tailscale funnel reset` closes it. `training-up.sh` waits for readiness and no longer implies the Funnel; `funnel-check.sh` now warns when the Funnel points at another port or another machine than the app's own (it stays a warning, not an authorisation). The image is tied to the exact commit: the workflow prints `IMAGE_REF=… COMMIT=…` and `pick-image.sh` finds the green run of `git rev-parse HEAD`, refuses a missing run or another commit, and prints the digest. Tests with stubs in `training-config.test.ts`. The workflow change itself is exercised by the next push.

**T3 regression (2026-11-05):** lint, typecheck, prettier, 275 test files / 4435 tests, production build pass. Full e2e, one worker: **167 passed, 2 skipped, 1 failed, 1 did not run in 34.3 min** (`.logs/t3-e2e.log`, the Mac was on battery). The failure, `ledger-payments.spec.ts:98`, timed out waiting for the login form (an environment stall, not an assertion); the file rerun alone passes 4 of 4, including the serial test that had not run. The review's NO-GO for Funnel stands until the on-iMac rehearsal of R11 section "Conditions" is done (forged forwarding header through the real Funnel, Keychain helper, volume ownership on Colima, `pick-image.sh` against a push made after this change).


## T2: Excel import tool for the go-live, started and finished 2026-11-06 (Ali asleep; decisions below are mine, to confirm)
Synthetic fixtures only; nothing read from `~/BELGOBETON-data` or any real file. Local commits, **not pushed** (an independent reviewer is reading `origin/main`). Only lint, typecheck, unit, integration and targeted tests were run; **no full e2e**. Decision 176 and `docs/IMPORT-EXCEL.md` hold the details.
- [x] **T2.1** reader and parsers: every named sheet of a workbook; strict dates (declared order, real calendar days) and amounts (ambiguity refused, integer centimes).
- [x] **T2.2** mapping file per sheet; pumps, reference prices per plant, recipes per plant, last invoice number; opening balances by name.
- [x] **T2.3** one workbook = one transaction (dry run = same work, rolled back); refusal on training / simulation / non-REAL_DATA / training-marked database; owner or app_admin plus step-up; audit entry with the file hash (migration 0117); idempotent by hash and by row; soft rollback of a run.
- [x] **T2.4** command line `--dry-run`, `--apply`, `--rollback`, `--init-mapping`: named account, confirmation phrase tied to the file, authenticator code (3 tries, audited), report without cell values. The old `import:excel <kind> <file> --apply` form is gone.
- [x] **T2.5** synthetic fixtures (`pnpm import:fixtures`), `docs/IMPORT-EXCEL.md`, RUNBOOK §4, a docs-drift test.
**Decisions made without Ali (all provisional):** the dry run is a rehearsal in a rolled-back transaction rather than an offline check (so cross-sheet references are validated for real); the dry run needs the production-mode database like the apply; the second factor in the command line is the authenticator code plus a typed phrase, no password prompt; rollback is soft (archive / cancel) and lists the sealed rows; the old per-kind form is removed because its apply had no step-up; default date order is day first, declared in the mapping.
**Not done / limits:** the real headers and sheet names (so the defaults are guesses and the mapping files are the answer); purchase price lists, stock counts, months of history, client price overrides; an apply was never run against a real production database (only the test database with `REAL_DATA=true` set on the child process); `app_admin` can apply, confirmed by Ali; the e2e suite was not touched or run.
**Answers from Ali (2026-11-06):** the real headers are not available yet, so the built-in defaults remain guesses and the per-sheet mapping files stay the adaptation path; the rolled-back dry run on the production-mode database is acceptable; owner and app_admin may both apply, with the typed phrase and a fresh authenticator code. Recorded in decision 176. Still not pushed.

## T4: fixes of the R12 review (`docs/reviews/CODEX-REVIEW-R12.md`), 2026-11-06
Spec: the review. One commit per finding, on top of the T2 commits. Decision 177.
- [x] **R12-01** (high) `21b5dbd`: all business state of `public` and `finance` (catalog-listed, allowlist, blind tables by statistics, unreadable = holding); `TRAINING_ALLOW_UNMARKED` needs `E2E_TEST_RUNNER=playwright` + `NODE_ENV=test` + a throwaway database, compose forces it off; runtime test with APP_ENV=training, TRAINING_MODE=true, REAL_DATA=false.
- [x] **R12-02** (high) `4dcbed0`: staging name covered by both ignore files, rename failure cleans up, startup sweep, no default output path, no checkout or build context as output.
- [x] **R12-03** (medium) `b858afb`: atomic per-IP reservation before Argon2, locking attempt counted, shared unknown bucket, in-flight bound; concurrent-HTTP integration test (60 parallel requests: exactly the configured 20 verified).
- [x] **R12-04** (medium) `9b785f9`: expiry erases and hides at once, 10 s abort, numbered reads; e2e with the read held pending.
- [x] **R12-05** (medium) `5b1454e`: Funnel gate fails closed (details in decision 177). The stub tests found and closed a fail-open (`grep` with no match under `set -e` left the Funnel open).
- [x] **R12-06** (medium) `192c7ea`: exact single match on label or login, refusal before any secret, French example is one driver code.
- [x] **R12-07** (low) `3711035`: QR and role check for the optional training enrolment, browser test.
- [x] **R12 conditions** `44456a8`: `init-env.sh` exclusive creation; the seven mandatory conditions in both guides.
**Remains for the on-iMac rehearsal (not provable here):** the seven conditions recorded on the actual machine; a genuinely fresh training volume and the digest of the CI image of the final commit; Keychain helper, `read:packages` token and GHCR privacy; the real Funnel with forged `X-Forwarded-For` (condition 5) and a supervised 4G login, change and logout; reset of the Funnel afterwards and an outside check. The burst/availability risk of R12-03 is bounded, not removed (an attacker can still lock drivers out; an operator must be ready to close the Funnel). Nothing public was opened or run for this work.

## T5: the training instance made usable (2026-11-06)
**Step 0 findings.** (1) Why the driver saw nothing: the seed is dated from the seed day but is a one-shot; the next day nothing is due, and even on the seed day CH-03 had no rotation while CH-01/CH-02 had one each, already departed. (2) Stages that exist: `loading_started` (driver report) and the `trip_event` steps `loaded`, `departed`, `arrived`, `unloading_started`, `unloading_finished`, `back`; planned minutes for load, depart, arrive, unload end and back are already stored on `trip_plan`. "Back at plant" exists. (3) How a driver gets the next order today: the plant manager saves the whole day's plan up front (every rotation, each with a driver, the truck's default driver proposed); `driver_trips` returns the driver's own rotations ordered by load time, so the next one is simply the next card. Nothing compares taps with the plan, re-plans, alerts or lets the manager reassign after saving.
**Phase 1 (decision 178).**
- [x] **T5.1** seed ends with today's work; `rearm:training` / `training-rearm.sh`; tests in `tests/training-seed.int.test.ts` (each phone driver 2 to 3 rotations to do today, history before today, quotes / unplanned order / order to cancel / low stock, re-arm does not double, next morning gets its own, refused without the marker).
- [x] **T5.2** cards FR + AR for nine roles, 15 phone screenshots in `docs/training/screens/`.
- [x] **T5.3** push button absent in training (already so in code; pinned by e2e).
Not done in phase 1: a credit-limit client for office_sales, owner decision items beyond what the pilot data already holds; cards not walked through by a person.

### T5 phase 2: dispatch and timing (decision 179)
- [x] **a** stages: the existing six (+ the driver's `loading_started`); none added.
- [x] **b** estimates per plant + zone + stage (median of the last 10 completed, at least 5; else audited override; else plan defaults); override by plant manager (own plant), owner, app_admin.
- [x] **c** schedule/projection/slip: `src/modules/operations/domain/trip-timing.ts` (pure), 21 unit tests: skipped stage, offline tap, midnight crossing, negative delay, DST-safe midnight.
- [x] **d** recording: `trip_delay` (planned, phone time, server time, stage and cumulative delay, reason), append-only, audited.
- [x] **e** alerts none / watch / critical (in-app only), driver banner, board, reassign and postpone with reason (audited); no client message, no automatic assignment.
- [x] **f** views: driver list with planned times and own status and no prices; plant board by truck; owner and app_admin both plants plus statistics by stage, route, driver, day.
- [x] **g** privacy in RLS, doors and the audit trail (integration test: eight roles).
- [x] **h** seed: late rotation, history delays for 49 completed rotations, override.
- [x] **i** tests: unit (21), integration `tests/trip-timing.int.test.ts` (17), seed tests (3 added), e2e `e2e/trip-timing.spec.ts` (late tap -> critical on the plant board -> reassign -> driver's list changes).
Not done: live refresh of the board (reload to refresh); the reason can only be chosen before the tap; no alert history screen; Chefchaouen has no driver accounts.
**T5 regression (2026-11-06, on AC power):** lint, typecheck, prettier, 151 unit files / 2172 tests, 136 integration files / 2447 tests; full e2e, one worker: **174 passed, 2 skipped, 0 failed in 34.3 min**. The first full run found one real defect of the new board (a number field without `dir="ltr"` on the Arabic screen check, 173 passed / 1 failed); fixed, targeted rerun, then the full suite again green. One unrelated test (`assistant-drafts`, "no readable amount in the sealed card") failed once because a random sealed value happened to contain the letters "MAD"; it passed three reruns and is a pre-existing flake of that assertion.


## T6: fixes of the R13 review (`docs/reviews/CODEX-REVIEW-R13.md`), 2026-11-06
Spec: the review (four medium findings, two small items). One commit per finding, on top of T5. Decision 180. No T5 feature was changed.
- [x] **R13-01** `0921dc7` (+ `2d500ab`): the empty-database proof no longer uses `pg_stat`. A table is empty only if its heap file has size 0 (metadata, not filtered by RLS) or an exact read finds nothing AND the maintenance login is not subject to a row policy on it; a table that has been written to and whose rows RLS may hide from that login **fails closed**. The table-catalog enumeration stays; no read policy and no `BYPASSRLS` was added. Provenance: `scripts/training/db-init/10-birth-token.sql`, mounted into the database container of the stock Compose file, runs once on the first creation of the volume and writes one birth token; the seed claims it atomically (superuser login of the ops container) and refuses a database without it. `reset:training` mints a new token after it dropped a marked database. The 1.5 s statistics wait is gone from the test. Tests: RLS-hidden-only rows refused (statistics analysed, then reset), written-then-deleted refused, restored/no-token refused, fresh stock volume admitted once, claim atomic under concurrency, skip only on test databases.
- [x] **R13-02** `0292871`: every reservation has a unique id (random, stored only as a keyed hash); a success releases THAT reservation (a row carrying the same id), the reservation keeps its original window time; the window count is reservations without a release. No migration was needed (the `login_attempt` table already had the columns; the id travels in `identifier_hmac`). Tests: window-crossing (reserve, complete after the window moved, a later burst gets exactly the nominal budget), release is per reservation and idempotent, original time kept; the concurrent HTTP test is unchanged and green. The per-driver lock is untouched.
- [x] **R13-03** `ee2d6af`: the reading of the day, its refusal, its expiry and the sign-out moved from the React component to `day-controller.ts`: what is shown is cleared synchronously, storage cleanup (local storage, IndexedDB photos, Cache Storage) is independent and never awaited by the screen, and the epoch is checked after every await (fetch, json, photos, the wipe for another account) before anything is committed. Ten unit tests with held IndexedDB and Cache Storage (refusal and sign-out interleavings, an older read resuming after a newer one, a delayed cleanup not erasing a newer day); two of them fail if the epoch checks are removed (checked by mutation).
- [x] **R13-04** `7c0e3b2` (+ `4cbcc11`): `go-public.sh` resets first and reads the status back closed (before even the arguments), no `|| true` on a reset, `CLOSURE UNCONFIRMED — check Tailscale manually` and a non-zero exit when a reset or the read-back fails (initial, refusal or exit clean-up), "closed" is only printed after the read-back. After opening, the complete status is validated: the structured status (`tailscale funnel status --json`, python3) must be exactly one HTTPS proxy to the verified loopback endpoint with the Funnel allowed on it; without JSON support the text is validated line by line. `funnel-check.sh` uses the same validation. Stub tests: a failing reset, a reset that leaves the Funnel on, an unreadable status, a failing clean-up reset, twelve statuses with extra non-proxy entries.
- [x] **Small 1** `10125c3`: the stale staged-credentials sweep runs right after the destination is vetted and before the marker and emptiness checks (tested after an interrupted half-seed and on a marked database). A side effect: an invalid destination is now refused even for an already seeded database.
- [x] **Small 2** `1e0e14a`: the `/app/out` exception requires an actual mount point (`/proc/self/mountinfo`, device comparison where that file does not exist).
**Docs:** CP-TRAINING.md and CP-TRAINING-IMAC-FR.md (fresh-volume and birth-token step, migrations through 0118, the new closure behaviour of `go-public.sh`).
**Cannot be proven here:** the on-iMac acceptance (the seven conditions) and a really fresh Docker volume through the image (the init script is checked by running its SQL on a cluster, not by `docker compose up` on a new volume); Tailscale's real `--json` output (the validator follows the documented serve-config shape; if the real shape differs, the check fails closed and the text form is used only when JSON is unavailable).
**T6 regression results (2026-11-06):** lint 0 errors (3 old warnings), prettier clean, typecheck clean, unit 2191 passed, integration 2458 passed, touched e2e (driver-app, trip-timing, training) 21 passed. ONE full e2e: 161 passed, 2 skipped, **6 failed** after 1.6 h (a run is normally about 20 min; the machine was slow): plant-screens, reorder, review-points, supplier-invoice, trip-timing, user-admin. Every failure was a sign-in/TOTP step ending on `/login` or a timeout, in specs that T6 does not touch (office sign-in, not the phone). Re-run alone, all six pass (3+3+5+6+1+3 tests). A re-run of the six together failed on four other tests in the same way, so I attribute this to the slow machine and the shared e2e database, not to T6; I could not find a cause in the code and a second full run was not made.

## T7: fixes of the R14 review (`docs/reviews/CODEX-REVIEW-R14.md`), 2026-11-07
Spec: the review. Three groups, one commit per finding; decision 181 (group A). Reference: the reviewed code is `f3cb07d`.
### Group A — training / iMac path
**Reading the boxes (R15a):** a checked box below records that the work was IMPLEMENTED and tested at the level named. It is NOT a security closure: `docs/reviews/CODEX-REVIEW-R15A.md` found Group A only partly closed, and the follow-up is section "Group A2" below. The phone logout/handover boundary stays unaccepted until the lifecycle findings are evidenced on a real browser.
- [x] **R14-06** `c23254b`: one session generation for sync, photo flush, day reads and wipes; a sign-out fences first and has an overall deadline; a stale wipe checks its epoch before `clearWaiting`; wipes are owner-scoped. Whole-lifecycle tests (`field-session.test.ts`): stalled network, sync/photo in flight at logout, re-login, delayed IndexedDB/Cache Storage.
- [x] **R14-07** `738cc97`: Funnel decisions on the complete structured status only; python3 required; unsupported CLI vs daemon error told apart; no text fallback, no loose "off"; `training-up.sh` propagates a failed check.
- [x] **R14-12** `75e5872`: seed/output lock with heartbeat before the sweep; the sweep needs the lock and only removes files older than 10 minutes.
- [x] **R14-13** `75cbe48`: marker bound to the database name; `wipeTrainingDatabase` checks mode flags and a birth row; test escape needs a runner signal; claims rewritten to the true boundary.
**Docs:** CP-TRAINING.md, CP-TRAINING-IMAC-FR.md, decisions 180 (corrected) and 181.

### Group A2 — the R15a findings (`docs/reviews/CODEX-REVIEW-R15A.md`), decisions 187 to 193
Implemented and tested with unit, fake-port or scratch-database evidence; none of it is a real-browser or on-the-Mac acceptance, and the R15a "runtime evidence still missing" list stands.
- [x] **R15A-01** `941d647`: a logout belongs to the generation that started it; its request is abortable with a 6 s deadline; the sign-in waits for it; the server logout is idempotent (decision 187).
- [x] **R15A-02** `0b732eb`: one sign-out operation guards every stage; expiry is terminal, also when the driver cancels leaving (188).
- [x] **R15A-03** `1986756`: a wipe captures a creation cutoff when it starts and never erases photos queued after it; storage-level tests over a fake IndexedDB (189).
- [x] **R15A-04** `57391a1`: photo capture captures owner and generation at its start, refuses stale work before the enqueue, makes the write generation-aware and keeps its guard through the flush (190).
- [x] **R15A-05** `bf89ffe`: seed lock by exclusive epoch files with a lease fence; the sweep deletes only stages of superseded attempts (191). Residual: the instant between a `held()` check and the action after it.
- [x] **R15A-06** `bb780af`: public helpers retired; local only, operator responsible for no publisher (192).
- [x] **R15A-07** `96fe258`: reset refuses legacy spent or unbound birth rows (193).
**Not proven here:** a real browser (aborted logout headers, logout then reload), real storage timing on a phone, the Mac having no publisher, a fresh Docker volume through the image.
**Cannot be proven here:** the real Tailscale `--json` output (assumed `{}` when empty) and a really fresh Docker volume; a pre-existing time-of-day dependent failure in `tests/training-seed.int.test.ts` ("one rotation is on the road and late") that also fails on f3cb07d when run in the early morning (Group B territory).


### Group B — T5 dispatch and timing (decisions 182 to 186)
- [x] **R14-01** `0aea83e` (migration 0119): one lock order (day, then the day's rotations, then audited writes); "started" includes the driver's loading report; the cancellation trigger and a new driver-report guard take the event writer's lock; one live rotation per (day, order, number); a double-booked driver/truck is refused unless an audited overlap reason is given; the reassign action returns the remaining conflicts. **The overlap rule is in the service, not a database trigger** (the seed and fixtures write overlapping rotations). Tests: `tests/dispatch-serialization.int.test.ts`, held transactions for each race; 13 of 15 fail on the old code (the two reassignment-race tests are regression tests, they pass before too).
- [x] **R14-02** `dd9ad84` (migration 0120): the explanation only in `trip_dispatch_change`; codes `reassigned` / `postponed` in the plan and cancellation; the restrictive audit policy covers eight tables (also rows written before). 4 tests fail before. **Residual by decision (183):** partner and support still read the operational plan and tap events.
- [x] **R14-05** `2e11d66` (migration 0121): positive role authorization, plant/assignment scope inside the function, a driver gets a median only with 3+ distinct drivers. 4 tests fail before.
- [x] **R14-14** `a59debe`: 17 screenshots regenerated (throwaway database, port 3190, separate build), page-success assertion, fiction label, invented driver labels. Three images were looked at by hand; the rest are guarded by the assertion and the label code.
- [x] **Small** `97aa82b`: decision 179 corrected, rearm documented (before sign-in, not all-or-nothing), the late-rotation seed test runs at a fixed hour.
**Not done / open:** the sales guide mentions *Devis*/*Commandes* screens the sales office profile does not have; a database-level overlap trigger; the full e2e (after group C, on AC power); `import-workbook` time-dependent test (group C).

### Group C — the importer (`docs/reviews/CODEX-REVIEW-R14.md`, scope C), decisions 196 to 203
Implemented and tested with unit and integration evidence on synthetic workbooks only. **Not an acceptance of the importer as a real-data gate:** that needs the independent review (R15b) and a rehearsal on a production-mode copy.
- [x] **R14-03** `f9df8a5`: applied/rolled back only after a confirmed commit; failed vs unknown outcome; destroyed connections; injected failures (not a real commit-time constraint).
- [x] **R14-04** `303c8e2`: 1904 workbooks, duplicate headers, unclosed CSV quotes and formula cells refused (cached values only by explicit mapping).
- [x] **R14-08** `a31cda1`: advisory lock; payload-equal idempotency; conflicts and duplicate opening balances block the file.
- [x] **R14-09** `f2c8b8a`: sheet positions and fixed codes in reports and CLI output; private log files; IMPORT-EXCEL.md corrected (row audit holds values).
- [x] **R14-10** `93f849a`: real opening tables in the soft-rollback inventory, unknown tables listed; correction procedure written.
- [x] **R14-11** `a0af786`: atomic TOTP step claim, persisted failure budget, eligibility rechecked, code bound to the operation; typed phrase over the full hash, mappings and opening date; `runImport` no longer exported.
- [x] **Extra 3** `b8a7d86`: the date-dependent rollback test fixed.
**Not proven here:** a real commit-time failure of the database, a real file, the real headers, an app_admin's complete rollback inventory (the owner's is complete), the proof object against a hostile caller with database access.
