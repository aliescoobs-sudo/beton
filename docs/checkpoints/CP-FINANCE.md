# Finance — isolated implementation on codex/finance

Source: `/Users/macplanet/BELGOBETON/docs/REQUIREMENTS-V1.md`, especially §3.8, §10, §16.11 and §16.12. Original checkout is read-only; no original `.env*` or `backups/` is used. Baseline: `bdc408b` (R1). This branch is not merged into main.

## Local isolation

Compose project **belgobeton-finance**, host PostgreSQL **127.0.0.1:5542**, volume `belgobeton-finance_belgobeton-finance-pg`; web **3200**, second e2e server **3201**. `pnpm db:*` explicitly selects this compose project. `.env.local` and `.env.ops` were generated afresh here with synthetic credentials, are ignored by Git, and were not copied. Superuser, backup and seed logins remain in `.env.ops`. No original container/volume is operated on; no prune or global deletion is used. Dev and e2e both use 3200, so run them sequentially.

## Implemented rules

- Module code under `src/modules/finance`, migrations **0200–0206**, dedicated schema `finance`. Default **off**. A missing migration also reads as off in the shell; other screens continue to work.
- `finance.read` / `finance.write`: **owner, app_admin**. `finance.export`: **owner, app_admin, accountant**. Support, office and operational roles inherit no finance right from their pilot document permissions. Finance audit payloads are also hidden from those roles.
- Every finance table: FORCE RLS, audited, append-only; no UPDATE/DELETE/TRUNCATE grant, including for the runtime. A separate schema registry and exposure tests cover these tables rather than silently omitting them from the legacy public-schema registry.
- Services, routes and database doors check access independently. All money writes require a fresh real TOTP, refuse recovery-login state, and run in READ COMMITTED for the existing audit hash chain. Database authorization precedes integrity triggers, so a guessed amount does not become an error oracle. Requests use the authenticated actor; no support/owner impersonation.
- Report title: **Résultat de gestion (données enregistrées)**. Plant rows, then central charges, then total. Monthly, quarterly, half-year and annual periods are supported by the period API; the screen also accepts explicit date ranges.
- Confirmed invoice-line revenue, negative invoice credit notes and partial **avoirs**. Missing R3 price confirmation fails closed: the amount is excluded and the report visibly incomplete.
- Materials come from **stock consumption movements**, including reversing movements, never purchase totals. An evidenced unit-cost snapshot values each movement; the database recomputes quantity × cost. Missing valuation stays visible and marks the report incomplete. Fuel is valued on dispensing, not tank purchases; pump fuel requires an explicit allocation key.
- Configurable fixed/variable categories, optional monthly repetition, explicit shared/pump allocation keys. Integer largest-remainder allocation conserves every centime, including reversals. Financing and steel costs stay central. Loan principal is outside result. Leasing has an explicit `expense` or `principal_interest` policy; its principal can be assigned to a plant, truck or key while its financing cost remains central.
- Loans and leases have validated schedules; a principal mismatch rolls back the whole facility. Cash principal is recorded separately from its repayments. Expense reversal is an appended negating entry, never deletion; it does not pretend already-paid cash was refunded.
- Treasury starts from ledger opening balances and actual cleared movements, adds finance settlements, and tracks cash holders by account. Transfers are atomic and have zero company-wide cash and result effect.
- Forecast includes recorded receivable/payable plans, cheques/LCN, fixed expenses, facilities and steel maturities. A linked instrument replaces only its portion of an installment. A cleared linked instrument is removed from the commitment and is already in actual ledger cash. Cross-allocation in ledger and finance is blocked under the same instrument lock. Overdue unpaid commitments remain due. Separate scheduled and early-presentation views are returned.
- Steel is direct supplier → buyer, no materials/stock movement. Delivery-day cash is booked to a cash account; purchase minus cash is **coût du financement par acier**; one to three supplier commitments start one month later and finish by month three. Simulation extends through the last cheque, covers the original gap and refuses a larger later shortfall. Deterministic ranking can try one or more deals and compare their total cost with a bank-cost input. Simulating never records a deal.
- Real `.xlsx` export: sales, purchases, avoirs and VAT summary only, never treasury, balances, loans or steel. HT + VAT = TTC and sales line totals reconcile. Dates and amounts are typed; untrusted strings are inline text, never formulas. No macros, external links, provider call or unencrypted file on disk. Every download is audited. VAT summary is indicative; deductibility remains the accountant's validation.
- French/Arabic phone and tablet UI, RTL and LTR money isolation, fresh-TOTP retry, CSRF same-origin checks, bounded mutation bodies, no-store exports. Separate accountant page loads no management data.

## Interfaces for the lead

Public finance exports are in `src/modules/finance/index.ts`; permission definitions and schema registry stay in finance. `module-map.mjs` and CAPABILITY-MAP add the five agreed dependencies. No ledger/operations/master-data implementation is edited.

R1 public API `listPlants` supplies plant identities; ledger public `listInstruments` supplies the human-readable cheque/payment picker, under the same actor’s own RLS. Required detail that has no sufficiently scoped public read is exposed through reviewed finance-owned SQL doors (`source_sales`, `source_consumption`, `source_fuel`, `source_accounts`, `source_flows`, `source_movements`, `link_state`, `accounting_journal`). They read existing source rows, return named fields and verify the stored actor role and flag, including a missing context. Runtime finance code never directly queries another module's base table. Review these doors with the finance migrations; if the lead prefers equivalent ledger/operations public exports, preserve the same field and security contracts.

Administrative activation: authenticated same-origin `POST /api/finance-configuration` with `{"action":"configure","enabled":true,"leasingTreatment":"expense"}` (or `principal_interest`), fresh TOTP required. Business `POST /api/finance` and `/[locale]/finance*` are 404 while off; the administrative switch remains available so the module can be activated. The schema flag needs connecting to the common module-switch helper when that lands.

## Integration dependencies / remaining acceptance

- **R2** has not landed in this checkout: `app_admin` and `accountant` cannot yet be provisioned by the core. Finance permissions and DB policies already name them; do not widen legacy support to stand in for either. `listPlants` needs R2's normal app_admin permission. Accountant exports require the owner to confirm the provisional §3.8 scope.
- **R3** must supply `sales_order.price_status = 'confirmed'`. Until then legacy invoice revenue is explicitly excluded from management result. Exports still reflect the issued documents.
- Lead resolves the shared Drizzle journal after merging parallel 0082–0199 migrations: preserve the SQL numbers 0200+, order all migration timestamps monotonically, and test a fresh database and an upgrade from the lead's current database. The isolation-only compose/scripts/ports commit is local to this worktree and should be reviewed separately from production finance code.
- Module remains off for users until server acceptance. No server deployment, real personal data, real-model AI, CNDP assertion, main merge or push is performed here.
- Assistant/tool connection is available through the deterministic public finance API; adding it to the assistant belongs to the lead's R10. Accountant's final export layout, tax deductibility, valuation evidence and leasing treatment still need human validation.
- Cash entries must be recorded once: use finance settlement for finance-origin commitments, or link their existing ledger instrument. Do not enter the same payment independently in both. Materials/fuel valuation records do not create another payment.

## Validation

Completed in the isolated worktree on 2–3 Nov 2026. The database/Docker pause requested by the user was respected before resuming database-dependent execution (not before **10:15:46 UTC on 2 Nov**). No Docker daemon, container or volume operation ran during that pause; the unit CLI smoke checks only parse compose configuration locally.

- `pnpm lint`: pass (ESLint and Prettier).
- `pnpm typecheck`: pass.
- `pnpm test:unit`: **1,747 passed**, 126 files. Focused finance domain/service/UI checks: **64 passed**, 6 files.
- `pnpm finance:integration`: **1,858 passed**, 102 files, including encryption/restore and existing stock/ledger/security tests. Finance’s **14 integration cases** use a separately recreated `belgobeton_scenario_test` database inside the 5542 cluster, so their plants and movements do not pollute the legacy R1 tests.
- `pnpm finance:build`: pass; operations credentials are removed from the build child environment, and simulation/external AI are off.
- `pnpm finance:e2e e2e/finance.spec.ts`: **3 passed**, one worker: owner expense and real Excel download, denied support access/write/export, Arabic phone/RTL and module-off behavior. Screenshots at 375 px in `.logs/finance-fr-phone.png` and `.logs/finance-ar-phone.png` were visually reviewed. No document overflow.
- `pnpm finance:migrate`: pass, including an upgrade of this copy’s existing 0200/0201 schema to 0206.
- `gitleaks stdin --redact` on the staged changes: no secrets found. No environment, key, log, backup or test-result file is committed.

First broad integration run found two setup issues, both corrected: the placeholder age recipient was replaced with a newly generated local synthetic identity, and finance fixtures were moved to their own test database. The first browser attempt exposed the existing server-before-globalSetup bootstrap order; the guarded finance runner now prepares e2e before starting servers. A subsequent test-only cleanup error (trying to log out from a 404 with no menu) was corrected by navigating home first. Final clean runs pass; timeouts were not increased.

Commits: isolation **`47c0a9b`**; the finance implementation and this checkpoint are in the following feature commit on `codex/finance`. No merge or push is performed.
