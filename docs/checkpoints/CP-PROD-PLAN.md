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
Four rights per money item, stated separately. Entering or printing never grants a balance or an aggregate. Source: `src/modules/platform-security/domain/visibility-matrix.ts` (this table is printed from it and a unit test fails when they differ); the balance column is proved in the database by `tests/visibility-matrix.int.test.ts`. Known exceptions: office_sales prints invoices with amounts; office_purchases enters supplier invoices and payments; the accountant exports HT, VAT and TTC; reference prices are visible to internal non-field roles (`public.reference_prices`).

| Item | Enters | Sees in a document | Sees balances and aggregates | Exports |
|---|---|---|---|---|
| Reference average prices (sell and buy) | owner, app_admin | owner, app_admin, office, office_sales, office_purchases, plant, plant_manager, support | — | — |
| Order and quote prices and totals | owner, app_admin, office, office_sales | owner, app_admin, office_sales, support | owner, app_admin, support | owner, app_admin, support |
| Sales invoices and avoirs | owner, app_admin, office, office_sales | owner, app_admin, office_sales, accountant, support | owner, app_admin, support | owner, app_admin, accountant, support |
| Supplier invoices and purchase prices | owner, app_admin, office, office_purchases | owner, app_admin, office_purchases, support | owner, app_admin, support | owner, app_admin, accountant, support |
| Payments in and out (cash, cheque, LCN) | owner, app_admin, office, office_sales, office_purchases | owner, app_admin, support | owner, app_admin, support | — |
| Client and supplier balances | — | owner, app_admin, support | owner, app_admin, support | — |
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
