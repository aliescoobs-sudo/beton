# T19 report: office go-live core (15 Nov 2026)

Build-first (D230). Fictitious data only; `~/KAYAS-real-data-private/` was not opened; nothing pushed or deployed. Every item is its own commit with tests; no red item was committed (one flaky test is named below).

## Decisions entered (docs/DECISIONS.md)
245 D-A office money visibility · 246 D-B opening at 30 Nov, go-live 1 Dec · 247 D-C outgoing payment control · 248 D-D payroll out of V1 · 249 D-E data scope · 250 D-F production host (new OVH VPS in Europe, `docs/RUNBOOK.md` note, staging scripts untouched) · 251 D-G fictitious twin seed (T20). The hard guard of D-E is in `CLAUDE.md`.

## What was built, per item
1. **Role matrix and money read** (migration 0239, commit 2933a27). Additional SELECT policies on `ctx.actor_role()`: `office_sales` reads the CLIENT side (sales_order, invoice, avoir, payment_plan_item, client opening balances, incoming instruments, their events and allocations, `invoice_payment_state`); `office_purchases` reads the SUPPLIER side (purchase, purchase plan, supplier invoices, outgoing instruments, supplier opening balances) and the CASH accounts only. New permissions `statements.client|supplier`, `instruments.read_in|out`, `cash.view`; the visibility matrix (§16.1) has one office exception per side and CP-PROD-PLAN.md is reprinted from it. Every office money view is audited (`recordMoneyView`). `tests/office-money-read.int.test.ts` proves in the database: each office role fails on the other side, on costs, margins, price grids, bank accounts and the finance schema; the importer now refuses a non-owner explicitly (it used to be refused only because office could not read back). Role sweep and the older tests were updated, not deleted.
2. **Money-read screens** (T18-UI list kit). `/statements` (clients for the Responsable, suppliers for the Assistante, with PDF and CSV of a statement), `/instruments` (own side only), `/reminders` (clients with balance, late amount and last reminder; a note logs a reminder, **no message is sent**; doors `log_client_reminder`, `client_reminder_list`, migrations 0240-0241), `/cash` (the Assistante's day: in, out, running balance per cash account), `/charges`, `/payment-requests`. fr and ar, desktop and phone, screenshots in `docs/ui/screenshots/office-*`.
3. **Opening at 30 Nov** (0242-0243, commit 2c110cb). New importer kinds `doc_counters` (CMD, BL, ACH, FA, forward only, door `set_doc_counter`), `account_balances` (cash and bank opening), `cheques_issued` (outstanding issued cheques with written date and due date); the existing client/supplier balances and cheques-in-transit kinds stay. Every opening row carries `source = 'opening_30_11'`, settable only by owner/app_admin (trigger), tables insert-only so a correction is a reversing entry. The dry run prints a TOTALS CONTROL (rows, MAD of the file and of the rows to write); idempotency by file hash already existed and is unchanged. Docs: `docs/IMPORT-EXCEL.md`.
   **Completed in T19-close A** (0251, commit 5bf9007): per-invoice open items for clients and suppliers (`open_items`: invoice number, date, due date, amount, balance; the party's line is made from its items with a known age, and the one-line `aging_unknown` balance stays the fallback, the two being alternatives for a party); loans and leasing with their instalment schedule (`obligations`); opening stock per plant and component (`opening_stock`: the existing signed `opening` movement dated the opening date, one per component and plant); issued cheques now carry the written date, the due date (`payment_instrument.due_date`) and the handover day from the sheet, defaulting to the opening date, never the import day. Doors only, insert-only, owner and app_admin, `source = opening_30_11`, totals control, idempotent on a second run, rejection report as before. Tests: `tests/opening-detail.int.test.ts`.
4. **Sales gaps** (0247-0250). Client PO number and commercial per order (`order_extra`, written in the order transaction; a deferred trigger refuses an order of a "PO required" client without its PO, on both order paths); the PO is printed on the BL and on the invoice PDF and shown on the order detail; client alias table (unique, never another client's name; the importer resolves aliases); per-client flags (PO required, HT/TTC basis) with a panel on the client page. The order doors were NOT rewritten (additive tables), so `create_order_with_method` and its callers are unchanged.
   **Completed in T19-close C** (commit ab9e3f0): the order form shows when the chosen client requires its PO number (note, mandatory field, the delivery step will not go on without it) and the client search matches aliases and says which alias matched.
5. **Payment control** (0245-0246). Outgoing payments: prepare (Assistante) → validate by ANOTHER user (Responsable) or approve (owner/app_admin above the upper limit) → issue carrying the request; nobody decides on their own preparation; the instrument insert of a non-owner role is refused by a trigger without a matching, unused, validated request. Limits are two parameters on the settings screen (1 000 and 5 000 MAD, provisional). J-1 list of issued cheques due tomorrow; owner's review of the small payments of the day. Existing instruments and the way they are read are unchanged.
   **Completed in T19-close B** (commit a8f411b): the owner's approvals inbox lists the outgoing payments above the upper limit and approves or rejects them from there behind a fresh second factor (`payments.approve`); the request page stays.
6. **Charges register** (0244). Beneficiary, category, HT/VAT/TTC, payment mode, supporting-document reference, status flow with the same bands (small: payable; middle: validated by another user; above: owner approval), a paid charge without a document is FLAGGED, list and CSV export (audited). Built on its own insert-only tables; the finance schema is untouched.
7. **Data-scope guard**. `scripts/data-scope-scan.ts` + `scripts/data-scope-scan.test.ts` (CI). Output on the repository (migrations, pilot seed, importer fixtures):
```
allowed   db/migrations/0019_client_site.sql:8   client_site.address_enc            [address]
allowed   db/migrations/0049_company_profile.sql:15  company_profile.address       [address]
allowed   db/migrations/0084_field_app.sql:92    trip_instruction.address_enc       [address]
allowed   db/migrations/0084_field_app.sql:110   pump_job.address_enc               [address]
allowed   db/migrations/0090_cancellations.sql:34 cancellation_case.redirect_address_enc [address]
5 finding(s), 0 blocking
```
No CIN, birth-date or health field exists. The four `_enc` delivery-site addresses and the company address are allow-listed WITH a reason; the delivery-site ones are an **open question for Ali and the lawyer** (SECURITY-DEBT).

## What is still partial
- Opening, per-invoice items and loans are STORED and listed by doors (owner, app_admin) but nothing reads them yet: statements and reminders still read the party's single line, there is no aging bucket screen and the instalments feed no cash forecast or due list. Cheques in transit (received) are still dated on the import day; only issued cheques take the handover day of the sheet.
- HT/TTC is stored and shown, the ledger stays HT.
- Charges do not feed `finance_entry` and the document is a reference, not a file; the export is CSV, not Excel. Charges must feed `finance_entry` from 1 Dec: that is T19b with the monthly owner table (decided, NEXT-STEPS).
- The second factor on an approval above the upper limit is an application rule on the inbox path; the request page and the database door do not require it (SECURITY-DEBT).
- Reminders and charges screens have e2e coverage for the main path only; there is no PDF of the reminder log.
- Items out of scope as stated: historical posting path, cash count with variance, bank reconciliation, month close, checklist, monthly table, SMS/GPS, payroll, portals.

## Ali's answers (15 Nov, T19-close)
1. The two payment limits stay parameters; the owner decides on Monday 16 Nov; no code change.
2. The four delivery-site `_enc` address columns stay allow-listed with their stated reason; the question "does a private individual's building-site address count as a personal address (D249)?" is in SECURITY-DEBT for the lawyer.
3. Charges must feed `finance_entry` from 1 Dec: T19b, with the monthly owner table (NEXT-STEPS).
4. The opening workbook has per-invoice aging for clients and suppliers, loans and leasing, and opening stock per plant and component from the 30 Nov physical count (built in T19-close A).
5. The Responsable sees only the supplier-side requests waiting for her (already so).

## What the office can do on 1 Dec / what stays in Excel
| Task | In KAYAS on 1 Dec | Stays in Excel |
|---|---|---|
| Client balances, statements, receipts and cheques per client, reminders log | Yes (Responsable) | Reminder messages themselves (nothing is sent) |
| Supplier balances, statements, outgoing payments, cash day | Yes (Assistante) | Bank reconciliation, cash count with variance |
| Outgoing payment control (prepare, validate, approve, issue), J-1 list | Yes | Payroll and advances (D248) |
| Charges register with supporting-document flag | Yes | Link to the accountant's monthly report |
| Client PO number on orders, BL and invoice | Yes | |
| Opening: parties (one line or per-invoice items), cash and bank, cheques in transit and issued, loans and leasing, opening stock, numbering | Yes, by the importer with a totals control | Aging buckets and the loan schedule as a forecast (stored, not yet read by a screen) |
| Dated history Jan-Nov | No (T19b) | Archive until loaded |
| Monthly owner table, month close | No | Excel |

## Tests
Unit and integration (`pnpm test`): green except `scripts/release-binding.test.ts` "--recover clears a stale git index lock", which fails only inside the full parallel run (it passes alone every time; it needs a quiet machine). Role sweep and the permission, definer and exposure catalogues were updated for the new doors, none was weakened. New suites: `tests/office-money-read`, `charges`, `outgoing-control`, `opening-t19`, `sales-gaps` (integration) and `scripts/data-scope-scan.test.ts`.

## End-to-end
**T19-close D: one full run, alone on the machine, on commit ab9e3f0 (the code of the final commit; the last commit only changes docs): 226 passed, 0 failed, 6 skipped, 0 not run** (38.6 min after a clean build with `SIMULATION_ENABLED=false`). The 6 skipped are the screenshot and visual specs gated by `UI_SCREENSHOTS` (`design-screenshots` fr and ar, `kayas-visual` four tests). No test failed because the data changed since a previous spec. New e2e in this run: the owner approves an outgoing payment above the upper limit from the inbox (`approvals.spec`), the order form finds a client by alias and makes the PO mandatory (`t19-office.spec`).

Earlier run (after T19, before the close): 217 passed, 3 failed, 4 not run, the three failures test-side and fixed (`master-price-override` option selector, `role-negatives` office PDF targets by D245, `reserved-roles` positive control counted the charges export).

## Unit and integration after the close
384 files: 6029 passed, 0 failed except `scripts/release-binding.test.ts` "--recover clears a stale git index lock" in the full parallel run (passes alone every time). In one of the three full runs `tests/advance.int.test.ts` "advancing 3 days = 3 x 1 day" failed once and passed alone and in the two other full runs (a collision of business dates on the shared test database, not related to T19). A first run of the close failed 41 tests because `opening-detail.int.test.ts` left an active plant behind (other suites refuse an order without a plant once one exists); fixed by archiving it in `afterAll`, and the mapping-file counts (14 to 17 kinds) were updated.

## Riskiest points for the final audit
1. The side split of D-A is enforced by additive RLS policies on `ctx.actor_role()` that expose whole rows (prices included) of the client-side and supplier-side tables; reads are audited at page level, not in the database.
2. The outgoing-payment gate is a trigger with a bypass for owner/app_admin/system and parameter limits editable without a second person; verify no other `out` insert path exists and the limits are the owner's.
3. The deferred PO trigger and the migrator update policy on `client`, and the opening `source` marker: verify no order path bypasses the trigger and that no request role can set `source`.
