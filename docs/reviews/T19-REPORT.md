# T19 report: office go-live core (15 Nov 2026)

Build-first (D230). Fictitious data only; `~/KAYAS-real-data-private/` was not opened; nothing pushed or deployed. Every item is its own commit with tests; no red item was committed (one flaky test is named below).

## Decisions entered (docs/DECISIONS.md)
245 D-A office money visibility · 246 D-B opening at 30 Nov, go-live 1 Dec · 247 D-C outgoing payment control · 248 D-D payroll out of V1 · 249 D-E data scope · 250 D-F production host (new OVH VPS in Europe, `docs/RUNBOOK.md` note, staging scripts untouched) · 251 D-G fictitious twin seed (T20). The hard guard of D-E is in `CLAUDE.md`.

## What was built, per item
1. **Role matrix and money read** (migration 0239, commit 2933a27). Additional SELECT policies on `ctx.actor_role()`: `office_sales` reads the CLIENT side (sales_order, invoice, avoir, payment_plan_item, client opening balances, incoming instruments, their events and allocations, `invoice_payment_state`); `office_purchases` reads the SUPPLIER side (purchase, purchase plan, supplier invoices, outgoing instruments, supplier opening balances) and the CASH accounts only. New permissions `statements.client|supplier`, `instruments.read_in|out`, `cash.view`; the visibility matrix (§16.1) has one office exception per side and CP-PROD-PLAN.md is reprinted from it. Every office money view is audited (`recordMoneyView`). `tests/office-money-read.int.test.ts` proves in the database: each office role fails on the other side, on costs, margins, price grids, bank accounts and the finance schema; the importer now refuses a non-owner explicitly (it used to be refused only because office could not read back). Role sweep and the older tests were updated, not deleted.
2. **Money-read screens** (T18-UI list kit). `/statements` (clients for the Responsable, suppliers for the Assistante, with PDF and CSV of a statement), `/instruments` (own side only), `/reminders` (clients with balance, late amount and last reminder; a note logs a reminder, **no message is sent**; doors `log_client_reminder`, `client_reminder_list`, migrations 0240-0241), `/cash` (the Assistante's day: in, out, running balance per cash account), `/charges`, `/payment-requests`. fr and ar, desktop and phone, screenshots in `docs/ui/screenshots/office-*`.
3. **Opening at 30 Nov** (0242-0243, commit 2c110cb). New importer kinds `doc_counters` (CMD, BL, ACH, FA, forward only, door `set_doc_counter`), `account_balances` (cash and bank opening), `cheques_issued` (outstanding issued cheques with written date and due date); the existing client/supplier balances and cheques-in-transit kinds stay. Every opening row carries `source = 'opening_30_11'`, settable only by owner/app_admin (trigger), tables insert-only so a correction is a reversing entry. The dry run prints a TOTALS CONTROL (rows, MAD of the file and of the rows to write); idempotency by file hash already existed and is unchanged. Docs: `docs/IMPORT-EXCEL.md`.
4. **Sales gaps** (0247-0250). Client PO number and commercial per order (`order_extra`, written in the order transaction; a deferred trigger refuses an order of a "PO required" client without its PO, on both order paths); the PO is printed on the BL and on the invoice PDF and shown on the order detail; client alias table (unique, never another client's name; the importer resolves aliases); per-client flags (PO required, HT/TTC basis) with a panel on the client page. The order doors were NOT rewritten (additive tables), so `create_order_with_method` and its callers are unchanged.
5. **Payment control** (0245-0246). Outgoing payments: prepare (Assistante) → validate by ANOTHER user (Responsable) or approve (owner/app_admin above the upper limit) → issue carrying the request; nobody decides on their own preparation; the instrument insert of a non-owner role is refused by a trigger without a matching, unused, validated request. Limits are two parameters on the settings screen (1 000 and 5 000 MAD, provisional). J-1 list of issued cheques due tomorrow; owner's review of the small payments of the day. Existing instruments and the way they are read are unchanged.
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

## What could not be done or is partial
- Opening: no per-invoice aging (one balance line per party, flagged `aging_unknown`), no loans/leasing, no opening stock kind; issued cheques are dated on the import day.
- Order form: does not yet show that a client requires its PO and its client search ignores aliases; HT/TTC is stored and shown, the ledger stays HT.
- Charges do not feed the finance entries; the document is a reference, not a file; the export is CSV, not Excel.
- Outgoing payments: no owner approvals-inbox entry (the request page lists them).
- Reminders and charges screens have e2e coverage for the main path only; there is no PDF of the reminder log.
- Items out of scope as stated: historical posting path, cash count with variance, bank reconciliation, month close, checklist, monthly table, SMS/GPS, payroll, portals.

## Open questions for Ali
1. Confirm the two payment limits on Monday 16 Nov (parameters on the settings screen).
2. Is a private individual's building-site address a "personal address" (D249)?
3. Should charges feed `finance_entry` (monthly report) from 1 Dec?
4. Which sheet shape will the opening workbook have (per-invoice aging, loans, stock)?
5. Is the Responsable allowed to see the supplier-side list of requests waiting for validation (she sees only those waiting for her).

## What the office can do on 1 Dec / what stays in Excel
| Task | In KAYAS on 1 Dec | Stays in Excel |
|---|---|---|
| Client balances, statements, receipts and cheques per client, reminders log | Yes (Responsable) | Reminder messages themselves (nothing is sent) |
| Supplier balances, statements, outgoing payments, cash day | Yes (Assistante) | Bank reconciliation, cash count with variance |
| Outgoing payment control (prepare, validate, approve, issue), J-1 list | Yes | Payroll and advances (D248) |
| Charges register with supporting-document flag | Yes | Link to the accountant's monthly report |
| Client PO number on orders, BL and invoice | Yes | |
| Opening balances: parties, cash and bank, cheques in transit and issued, numbering | Yes, by the importer with a totals control | Per-invoice aging, loans, opening stock until the kinds exist |
| Dated history Jan-Nov | No (T19b) | Archive until loaded |
| Monthly owner table, month close | No | Excel |

## Tests
Unit and integration (`pnpm test`): green except `scripts/release-binding.test.ts` "--recover clears a stale git index lock", which fails only inside the full parallel run (it passes alone every time; it needs a quiet machine). Role sweep and the permission, definer and exposure catalogues were updated for the new doors, none was weakened. New suites: `tests/office-money-read`, `charges`, `outgoing-control`, `opening-t19`, `sales-gaps` (integration) and `scripts/data-scope-scan.test.ts`.

## End-to-end (one full run, alone on the machine, after T19)
217 passed, 3 failed, 4 not run (they follow a failure in the same serial file). The three failures were test-side and are fixed and re-run green by file (reserved-roles 9/9, role-negatives and master-price-override 14/14 with the other two):
- `master-price-override`: its `B25` option selector matched the extra fixture classes `FXB25G/FXB25P` made by earlier T17 suites; now `^B25 `.
- `role-negatives` (office PDF/export targets): by D245 the Responsable now legitimately reads client statements (PDF and CSV); the test now asserts that, and still refuses her everything else and the Assistante and legacy office all of it.
- `reserved-roles` (partner sweep): the sweep's own positive control, a valid admin, exports the new charges register, an audited export that the "no business write" counter saw; `export:charges` is excluded from that counter.
The T18-UI failure found earlier (inline `style` on status chips blocked by the CSP once lists had data) was fixed in commit 9ca5db7 and covered by a unit guard. The full run was NOT repeated after these test-only fixes.

## Riskiest points for the final audit
1. The side split of D-A is enforced by additive RLS policies on `ctx.actor_role()` that expose whole rows (prices included) of the client-side and supplier-side tables; reads are audited at page level, not in the database.
2. The outgoing-payment gate is a trigger with a bypass for owner/app_admin/system and parameter limits editable without a second person; verify no other `out` insert path exists and the limits are the owner's.
3. The deferred PO trigger and the migrator update policy on `client`, and the opening `source` marker: verify no order path bypasses the trigger and that no request role can set `source`.
