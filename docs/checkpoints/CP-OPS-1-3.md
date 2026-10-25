# CP-OPS-1 to 3: the operations core, end to end

Reviewed by: nobody yet (the owner asked to continue through the night while everything is green). Everything below is
committed and passed lint, prettier, typecheck, unit and integration tests, the production build and the e2e specs named at
the end of each section.

## Built since the operations plan
| Task | Commit | What |
|---|---|---|
| O4 | 48df73b | plant screens: "Chargements" (orders due with what is left, one tap to load, the day's delivery list with the signed-BL return), "Stock" (levels against thresholds). No price, total or client contact. |
| O7 | 3eeda04 | delivery note (BL): one reviewed definer function `delivery_note()`, printable page, print audited as an export. |
| L20 / L21 / O5 | 67b18e6, da26148 | purchases, supplier receipts that add stock (`record_receipt()`), stock thresholds and the derived status, receipts screen. |
| L17 | da26148 | invoices from the loads of an order (the pulled-forward ledger task the flow needs), with the credit note service. |
| L35 / O6 | 697e278 | "what did this action change": typed effects filtered by role; the order → load → stock → invoice → cheque → cash flow runs as an e2e. |
| O8 | 697e278 | operations in the pilot scenario: loads, signed BL, opening stock, thresholds, purchases and receipts, supplier payments, invoices and a credit note. |

## Acceptance criteria now green
AC-OPS-01, 02, 03, 04, 08, 09, 10, 11 (unit/integration: `tests/delivery`, `stock`, `receipt`, `plant-views`, `delivery-note`;
e2e: `operations-loads.spec.ts`, `flow.spec.ts`). AC-LED-26 (effects by role): `domain/effects.test.ts`, `invoice.int`,
`plant-views.int`, `flow.spec.ts`. Plant software import and reconciliation are still the `reconciliation` module's.

## Deviations from the plan
- **Threshold**: the plan's `stock_threshold` table exists (insert-only, owner and partner write) *and* master data already had
  `component.low_stock_threshold`. The stock status uses the latest `stock_threshold` row, else the component's own value when
  it is above zero. Decide whether to keep one of the two.
- **Purchases are in their own tables** (`purchase`, `purchase_line`, `purchase_plan_item`), not in `payment_plan_item`
  (whose guards are the order's). `allocation` got a second target (`purchase_plan_item_id`, exactly one of the two).
- **Receipt is whole-purchase**: one receipt per purchase (unique), no partial receipts. Cancelling a received purchase
  reverses the money and keeps the stock (the goods did arrive); a stock correction is a separate, later action.
- **Client name on the BL**: shown to everyone but the plant (DECISIONS 81: the plant sees the client code only). The AC says
  "client code and name"; confirm whether the plant should print the name.
- **Office and the delivery list**: office reads deliveries but not the order behind them (blind entry), so its list shows the
  BL number, truck, date and volume without order or client.

## Security-relevant changes beyond the plan (flag for review)
- Three more `SECURITY DEFINER` functions the application role can execute, all role-checked, fixed `search_path`, listed in
  `tests/ledger-exposure.int.test.ts` (a new function fails it until reviewed): `delivery_note(uuid)` (names, places and
  quantities, no money; client name null for plant), `record_receipt(uuid, date)` (owner, partner, plant, system; returns the
  receipt id only), `invoice_source(text)` and `allocate_to_purchase(uuid, text)` (see CP-L4).
- A second reviewed view, `purchase_line_ops` (quantities only for plant and partner), a security barrier like
  `sales_order_ops`; the exposure test now lists both.
- `next_doc_number` already accepted plant and partner for the `BL` prefix only (O2); unchanged.
- The seed role may now also insert deliveries, returns, stock movements, purchases, invoices, thresholds and the company
  profile (SELECT/INSERT only, request context `system`); `belgobeton_system` still writes none of them.

## Open points for the owner
1. Low-stock thresholds per component (the pilot sets them from consumption; the plant knows the real ones).
2. A load beyond the order's volume is refused (could be a warning).
3. Stock correction (count adjustment) and load cancellation screens are not built (services exist for cancellation).
4. Plant software export format (open question 3).
