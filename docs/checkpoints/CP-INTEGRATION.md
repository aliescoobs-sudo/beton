# CP-INTEGRATION: the document chain against the real app

Audit of 2026-10-26, **read only** (no code, no migration). Method: schema (db/migrations 0000 to 0063), services, pages, permissions (`src/modules/platform-security/domain/permissions.ts`) and the file list of the app. Nothing was run in a browser for this audit; the verdicts come from reading the code. A "works end to end" verdict means every step is built and reachable by the right role; it does not mean the screen was re-tested today.

Roles: **O** owner, **Of** office, **P** plant, **Pa** partner, **S** support. Money = O and S read; office writes blind (DECISIONS 81, 84).

## Summary

| # | Link | Verdict | Main gap |
|---|---|---|---|
| **Sales chain** | | | |
| S1 | Order | works end to end | |
| S2 | Planned rotations | works end to end | office has no view yet (decision 91 answer) |
| S3 | Loaded, BL automatic, sequential, no price | works end to end | |
| S4 | Delivered | partial | tracked in trips, but not linked to the order's status or to invoicing |
| S5 | Signed BL returned | partial | marked; no scan upload |
| S6 | "Delivered, not invoiced" queue per client | **missing** | no screen, no query |
| S7 | Invoice from selected BLs, one action | partial | service takes BL ids; screen invoices a whole order by code; one line per load, not grouped; advances not applied on the document |
| S8 | Payment: cash, cheque, LCN, split, instalments, oldest first | partial | allocation is oldest plan item **of one order**, never across a client's invoices; payment is entered per order code |
| S9 | Instrument lifecycle and bounce | works end to end | |
| S10 | Client statement with running balance | works end to end | |
| S11 | Cash and bank movements | works end to end | |
| **Purchase chain** | | | |
| P1 | Purchase order | partial | one `purchase` record is both the PO and the supplier invoice (no PO stage) |
| P2 | Receipt, partial allowed | works end to end | |
| P3 | Stock goes up | works end to end | |
| P4 | Supplier invoice entry, three-way match, photo, AI flag | **missing** | only an invoice number and date on the purchase; no match, no attachment, no feature flag |
| P5 | Payable | works end to end | |
| P6 | Payment: transfer, cheque, split cheques | works end to end | |
| P7 | Supplier statement | works end to end | |
| **Cross-cutting** | | | |
| X1 | Order-chain view (ordered, planned, loaded, delivered, invoiced, paid) | partial | orders list has delivered, total, paid and state; no planned, no invoiced stage, no per-stage view |
| X2 | Links between neighbouring documents | partial | only loads to BL and statements; order, invoice, purchase, receipt pages have no links |
| X3 | One search box by document number | **missing** | |
| X4 | PDF for every printable document | partial | browser print (Save as PDF) of invoice, quote, BL; no server PDF, none for statements |
| X5 | CSV for statements and journals | works end to end | statements, sales and purchase journals, payments, ageing; audited |

Also asked:
- `docs/REFERENCE-MAP.md`: **does not exist**. `docs/SPEC-assistant.md`: **does not exist** (the closest document is `SPEC-ai-layer.md` at the repo root, status DRAFT).
- In-app assistant: **nothing built**. No `LlmProvider`, no pseudonymiser, no feature flag, no Telegram. The only trace is the permissions `ai.qa` (money readers) and `ai.assisted_entry` (office), declared and unused.

## Sales chain, link by link

**S1 Order. Works end to end.** `ledger/service/order-service.ts`, `order-read.ts`, pages `orders/new`, `orders`, `orders/[id]`, quotes `quotes/*`. Office creates blind through `create_order` (returns the code only); owner, support read amounts; plant and partner read orders without prices (`orders.read`); a correction is a reversing row. Plan presets: cash, advance 50 %, three instalments, cheque 30 days, custom.

**S2 Planned rotations. Works end to end.** `operations/service/dispatch-service.ts`, `trip_plan` (0058), page `dispatch`. Owner, plant, partner, support read (`dispatch.read`); plant and owner write. Office: no page, no link, by design until decision 91's new answer is built.

**S3 Loaded, BL. Works end to end.** `delivery-service.ts` `createLoad`, `delivery` (0041), `next_doc_number` (BL-YYYY-nnnnn, gapless counter), `delivery-note.ts`, page `deliveries/[id]`. The BL is created inside the loading transaction, which also takes the stock down (`stock_movement`); the note shows names, place, type, m³, truck, times and signature boxes, no price, no total. Everyone reads and prints it (`deliveries.read` is ALL); plant, owner, partner create (A11).

**S4 Delivered. Partial.** The six tracking steps (`trip_event`, 0059, page `trips`, plant phone screen) include `delivered`. But the order list's "delivered" column counts loads, and nothing reads the `delivered` step for the order or the invoice. A load is invoiceable as soon as it exists, delivered or not.

**S5 Signed BL returned. Partial.** `recordBlReturn`, `delivery_return` (once per load, insert-only), `bl-return-button.tsx` on `loads`; plant, office, owner, partner (`deliveries.bl_return`), audited, double recording refused. **No scan or photo upload** (no storage of files anywhere in the app). The return does not gate invoicing.

**S6 "Delivered, not invoiced" queue per client. Missing.** The database knows which loads are not invoiced (migration 0046 reads it inside `create_invoice`), but no screen, service or export lists them, per client or otherwise. The owner cannot see what is waiting to be billed.

**S7 Invoice from selected BLs. Partial.** `invoice-service.ts`, `public.create_invoice` (0052), `invoice` and `invoice_line` (0046), pages `invoices/new`, `invoices/[id]`. Works: FA-YYYY-nnnnn gapless, the client's name and ICE and the VAT rate copied, due date at most 120 days (law 69-21), legal mentions from the company profile, credit notes by reversing row, a load invoiced once. Gaps: the screen takes **an order code** and invoices every uninvoiced load of that order (the service and SQL already accept `deliveryIds`, the screen does not); **one line per load** (BL in the description), not grouped by product; **advances are not applied** on the invoice (an advance is a plan item paid by an instrument; the document shows no deduction). Office creates blind, sees the number only; owner, support read and print.

**S8 Payment. Partial.** `payment-form.tsx`, `payments/new`, `instrument-service.ts` `receiveInstrument` / `issueInstrument`, `allocation` (0038, 0048), `allocate_to_order`. Methods cash, cheque, LCN, transfer. Split cheques and instalments exist as several instruments or several plan items on **one order**. Allocation fills the oldest open plan item of that order; the invoice's paid state is derived per order, oldest invoice first (`invoice-payment.ts`). Gap: a payment cannot be spread over several orders or invoices of a client, and the entry asks for an order code, not a client.

**S9 Instrument lifecycle. Works end to end.** `instrument-service.ts` (portfolio, `deposited`, `cleared`, `bounced`, regularize, dispute, cancel), page `instruments`, `deposit-batch.tsx`. `cleared` writes one signed `money_movement` in a database trigger. `bounceInstrument` reverses the allocations (the covered items reopen) and returns the regularization deadline (30 days, law 71.24); the rules engine raises reminders at days 20 and 27 (D89). Owner manages; support reads; office enters blind.

**S10 Client statement. Works end to end.** `statement-service.ts`, `statements/[kind]/[id]`, running closing balance (`balanceCentimes`), commercial and financial sides apart (D82). Owner and support only; every view and export audited.

**S11 Cash and bank movements. Works end to end.** `cash-service.ts`, page `cash`, `money_account` and `money_movement`, accounts page, opening balances. Owner and support.

## Purchase chain, link by link

**P1 Purchase order. Partial.** `purchase-service.ts`, `purchase`, `purchase_line`, `purchase_plan_item` (0044), pages `purchases/new`, `purchases`, `purchases/[id]`. One record (ACH-YYYY-nnnnn) carries the supplier, lines, plan, and optional `supplier_invoice_no` / date. There is no separate "PO" and "supplier invoice"; a purchase entered from an invoice and a purchase ordered before the invoice are the same table. Office enters blind; owner, support read.

**P2 Receipt. Works end to end.** `receipt-service.ts`, `purchase_receipt` and `purchase_receipt_line` (0045, 0053), page `receipts`. Partial receipts until each line is complete; an over-receipt only by the owner with a confirmation (D86). Plant, owner, partner, support see quantities, no price.

**P3 Stock up. Works end to end.** Each receipt part writes its `stock_movement`; `stock`, `stock/projection`.

**P4 Supplier invoice and three-way match. Missing.** No comparison of PO, receipt and invoice quantities or prices; no gap flag; no attachment table or file storage (so no photo); no AI extraction and no feature flag (see the assistant section). The `supplier_invoice_no` text field is all that exists.

**P5 Payable. Works end to end.** Due dates and plan items on the purchase, the deadline alerts (`deadlines`), the payables ageing in the accountant export.

**P6 Supplier payment. Works end to end.** `issueInstrument` with `allocate_to_purchase` (0048): transfer, cheque, split cheques as several outgoing instruments; the oldest open item of that purchase first.

**P7 Supplier statement. Works end to end.** `getSupplierStatement`, same page and CSV as clients.

## Cross-cutting

**X1 Order-chain view. Partial.** `orders/page.tsx`: code, client, type, delivered m³, delivery date, total, paid, state. The planned stage (dispatch) and invoiced stage (invoice exists) are not columns; the stages are not shown as a sequence. Total and paid for owner and support only.

**X2 Neighbour links. Partial.** Built: `loads` to the BL; statements and the dashboard link onward. Missing: BL to order to invoice to payment, and receipt to purchase to supplier invoice. Order page lists its loads and invoices without links; invoice page shows the order code as text; purchase page has no receipt link.

**X3 Search by number. Missing.** No search box, route or service. The office types an order code by hand in the invoice and payment forms.

**X4 PDF. Partial.** Invoice, credit note, quote and BL print through the browser (`print-button.tsx`, `@media print`, each print audited); no PDF library is installed and no server-side PDF exists. Not printable: statements, purchases, receipts, payment receipts.

**X5 CSV. Works end to end.** `statements/[kind]/[id]/export`, `accounting/export` (sales journal, purchases journal, payments with cash and bank movements, receivable and payable ageing), owner and support, audited.

## What each role sees today (chain screens)

| Screen | O | Of | P | Pa | S |
|---|---|---|---|---|---|
| Orders, quotes, invoices, payments | all, with amounts | create blind, number only | orders no prices | orders no prices | read all |
| Dispatch, trips | read, plan | none | read, plan, track | read | read |
| Loads, BL | yes | yes (BL, return, loss) | yes | yes | yes |
| Purchases | all | create blind | list of what to receive, no price | none | read all |
| Receipts | yes | none | record | read | read |
| Instruments, cash, statements | yes | enter blind | none | none | read |
| Accountant export | yes | none | none | none | read |

## Order of the gaps, by what blocks the owner most

1. S6 and S7: the owner cannot see what to invoice, and invoicing by selected BLs, grouped by product, with advances applied, is not reachable.
2. P4: three-way match and attachments (also needed for S5 scans); a storage design (encrypted, access by role, audited) is the real decision.
3. X3, X2, X1: search, links, chain view (read-only work, no money rules).
4. S8: allocation across a client's invoices.
5. X4: server PDF.
6. The five answers of 2026-10-26 recorded in DECISIONS 91 and 93 and not built: default driver per truck and per-rotation override with audit, office read-only dispatch view with its exposure test, overdue orders flagged on the board (a due-date note already shows on `dispatch/page.tsx`; to check whether it is visible enough), the avoir for rejected concrete (owner only, step-up).
7. Missing documents: `docs/REFERENCE-MAP.md`, `docs/SPEC-assistant.md`, and the assistant itself.
