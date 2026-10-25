# CP-L2 and CP-L4 (4a, 4b): orders complete, invoices, purchases, documents

Reviewed by: nobody yet. Committed with the full pipeline green; the commits are listed per task.

## Built
| Task | Commit | What |
|---|---|---|
| L6 | f936de2 | price override on one order: owner only, reason mandatory, stored and audited; office keeps the price in force (service and database). |
| L7 | f936de2 | orders list and detail (state of each échéance, loads, invoices, payments), cancel button with step-up. |
| L17 / L18 | da26148, 697e278 | invoices (gapless FA numbers, client name/ICE/VAT copied, issue deadline, due date 69-21), credit note, invoice list. |
| L19 | f936de2 | legal deadlines read model (invoices to issue by month end, invoices to collect, purchases to pay) and screen. |
| L20 / L23 | 67b18e6, f936de2 | purchases: entry (office blind), list, detail, cancel. |
| L22 | f936de2 | supplier payments: outgoing instruments allocated to purchase plan items; office names the purchase code. |
| L29 | d3561d8 | company legal identity (versioned, insert-only), printed on the BL, invoices and quotes. |
| L30 | d3561d8 | invoice as a printable document, print audited as an export. See the limit below. |
| L31 | 61bc755 | quotes: priced at the price in force, no ledger effect, printable, converted by saving the prefilled order form. |
| L32 | d3561d8 | accountant export: sales journal, purchases journal, payments and movements, ageing; refused if it does not tie out. |
| L25 | d3561d8 | the screen check (direction, overflow at 375/1280, missing keys, CSP, Latin codes in Arabic) for every ledger and operations screen. |
| L26 (part) | 5204694 | coverage gate (≥ 90 %) now covers `ledger/domain` and `operations/domain`. |

## Acceptance criteria now green
AC-LED-01, 02, 03 (orders, purchases, invoices, quotes: no UPDATE/DELETE grant, cancelling is a reversing row), 08, 09, 10, 11,
12, 13, 15, 16, 17, 18, 19 (invoices and purchases in the statements), 22, 23, 24, 26, AC-SEC-04/05 for every new table (matrix and
`money-visibility`: zero rows for office, partner, plant, system, anonymous on every money table). Tests: `invoice.int`,
`purchase.int`, `supplier-payment.int`, `order-price-override.int`, `quote.int`, `company-profile.int`, `accounting-export.int`,
`receipt.int`; e2e `ledger-orders-view`, `ledger-purchase`, `ledger-documents`, `ledger-quote`, `ledger-screens`, `flow`.

## Deviations
- **No PDF library** (L30). The document is an HTML page built from the stored rows with a print style; the browser's
  "Imprimer" also saves a PDF. Adding a server-side PDF library needs the supply-chain and licence check the plan asks for, so
  it is left to you. Arabic and French labels exist; the legal mentions are language-neutral.
- **Office creates an invoice by the order's printed code** (`invoice_source(text)`), not by picking an order (office cannot list
  orders). The same holds for supplier payments (`allocate_to_purchase`).
- **Invoice status** is not stored or shown as paid/partially paid: payments cover plan items of the order, and the legal
  deadlines screen treats an invoice as collectable until the order's items are fully covered.
- **Invoices in statements** are documents on top of the orders (never added to the balance).
- Quotes carry the price in force; a different price is the owner's decision when the order is saved (L6).

## Security-relevant changes beyond the plan (flag for review)
- `invoice_source(text)`: owner, office, system. Returns the order's client, unit price and uninvoiced loads so that office can
  invoice by code without reading orders. It is the same deliberate door as `resolve_selling_price` (price visible to the
  server, never shown to office). Listed in the exposure test.
- `allocate_to_purchase(uuid, text)`: owner, office, system; returns a count only.
- `record_receipt` accepts `system` so that the seed can call it; `belgobeton_system` has no EXECUTE.
- RLS change on `sales_order`: the owner may now insert an order with a reason (price override). Office still cannot.
- `audit.is_money_table` grows with `purchase*`, `invoice*`, `quote`.

## Open points for the owner
1. A PDF library (L30), and confirm the printed layout and mentions with the accountant (open question 13).
2. Whether the plant sees the client's name on the delivery note.
3. Invoice payment status (a payment is tied to the order's plan items, not to an invoice).
4. Partner still reads no money (DECISIONS 81 provisional).
