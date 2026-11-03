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
