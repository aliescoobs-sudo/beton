# CP-RE-1: security fix of the office doors (review of CP-L4, point 1), then the rules engine core

Written 2026-10-25. Reviewed by: nobody yet. Everything below passed lint, prettier, typecheck, the unit suite (1264) and the integration suite (1212).

## 1. The office doors (HIGH, done first, migration 0052)
**Finding confirmed.** `invoice_source(text)` returned the client, the unit price and the loads of any order code to an office-context call, order codes are sequential, so a price list could be enumerated. Two more doors had the same pattern:
- `resolve_selling_price` returned the price of any type for any client to office.
- The guard triggers were an oracle: a BEFORE trigger fires **before** row-level security is evaluated, so an office INSERT that RLS would refuse still returned "the price is not the one in force" (a yes/no on a guessed price).

**Fix.**
| Door | Now |
|---|---|
| `invoice_source` | dropped. `create_invoice(order_code, delivery_ids, due, today)` builds the invoice entirely inside the database and returns the number only. Unknown order, nothing left to invoice and loads that do not match give one answer (NULL). Every NULL is audited (`permission_denied` on `invoice_create`); ten in ten minutes lock the actor out (42501). |
| `resolve_selling_price` | owner and system only. The guards use `_price_in_force`, which the application role cannot execute. |
| office `INSERT` on `sales_order`, `payment_plan_item`, `quote`, `invoice`, `invoice_line` | policies are owner-only. Office goes through `create_order`, `create_quote`, `create_invoice` (definer functions; they return the code, and for orders and quotes the new row's id, never an amount). |
| price checks in the guards | moved to AFTER INSERT triggers (`sales_order_price_guard`, `quote_price_guard`, `invoice_line_price_guard`), reached only by a row the caller may write. |

`create_order` and `create_quote` re-implement the totals and the payment-plan split in SQL (same `scale_qty` rounding). `tests/office-doors-parity.int.test.ts` compares them with the TypeScript domain functions on random volumes, prices and plans: identical to the centime. The owner still uses the TypeScript path (price override, preview).

**Exposure tests** (`tests/ledger-exposure.int.test.ts`, "review of CP-L4"): the reviewed function list; office never receives a price from `resolve_selling_price`, `create_*` (result columns are `code`/`id` only, no leak by regex over the whole result); probes with unknown codes are audited and locked out after ten; every direct office insert is refused with 42501 and no price in the message; bad plans, unknown client or type and a missing price give errors with no amount; partner, plant and support cannot call the creators.

**Other doors checked, left as they are** (and why): `ledger_parameter` (VAT rate, reversal window, clearing delay: not money amounts), `next_doc_number` (a number), `default_cash_account` (an account id), `allocate_to_order` / `allocate_to_purchase` (a count, never an amount; they cover oldest-first so no error depends on a guessed amount), `delivery_note` (names, places, quantities; no money), `record_receipt` (a receipt id).
**Residual to note:** the count returned by `allocate_to_order` tells office how many plan items a cheque covered, which says something about the shape of a plan. It is not an amount; say if you want it removed.

Seed role: `belgobeton_seed` executes `create_invoice` instead of `invoice_source` (db/seed/seed-role.sql). The dev database was migrated (52 migrations).

## 2. Rules engine core (domain, persistence, services)
See tasks/plan-rules-engine.md. Domain (pure, 128 unit tests): working days, flows, forecast base and worst, black day, rules catalogue, alert state, what-if, options (AC-RE-09 fixture reproduced exactly), stock risk and options. Migration 0051: `alert`, `alert_event`, `cash_decision` (insert-only, money tables). Services: facts, run, alerts sync and reclassify, apply option (step-up `cash.apply_option`, permission `cash.decide`), dashboard views.
Rule: no arithmetic operator on a `Centimes` value outside `lib/money` (the scan in scripts/centimes-arithmetic.test.ts covers the new module).

## 3. Owner dashboard (replaces the interim home)
`/fr` for the owner and support: the brief (template text, AI off), cash (encaissé / total / cheques to debit), the forecast chart (SVG: cash above the line, deficit hatched below it, the worst case dashed, the safety threshold, the flows listed under each day, 7 or 14 working days), the black day with its causes, the alerts (conflicts first, then by severity, "détecté le … N jours avant"), stock of the next days, loads, invoices to collect, late clients (not counted), excess loads to confirm, decisions taken. `/fr/alerts/<key>`: the report, ranked options with computed coverage and the what-if forecast, "Préparer" then "Confirmer" (fresh 2FA; the early deposit really deposits, the other options record the decision and a draft message to copy), "Reclasser" with a reason. `/fr/stock/projection`. Office, plant and partner get a "today" with loads and stock alerts and no money (an e2e scan finds no formatted amount in their HTML, and the report and cash pages are 404 for them). Support reads everything and can confirm nothing; its views are audited.
Verified: `e2e/owner-dashboard.spec.ts` (7 tests), run with the whole suite.

## 4. Review points 2 to 7 (migrations 0053 to 0057)
| # | Done |
|---|---|
| 2 | Invoice payment state derived (paid / partial / unpaid, oldest invoice first) from the order's covered plan items; on invoices, the invoice page, statements and the dashboard; owner and support only. `ledger/domain/invoice-payment.ts` (property test), `tests/invoice.int.test.ts`. |
| 3 | Partial receipts: `purchase_receipt_line`, `record_receipt_lines`, several receipts per purchase until each line reaches its ordered quantity; over-receipt only by the owner with a confirmation, flagged on the receipt. Existing receipts converted (one line per stocked line). The stock risk reads the remaining quantity. |
| 4 | A load past its order is allowed with a warning (never blocks the plant); the database records the excess (`delivery_excess`, written by a trigger); the owner confirms it with a fresh 2FA (`delivery_excess_confirmation`), it is billed at the order's price; tolerance parameter `load_excess_tolerance_bp` (default 500 = 5 %, 🟡). |
| 5 | `stock_threshold` is the only source; the component's old values were copied into it and the column dropped; the component form no longer has the field. |
| 6 | DECISIONS 83 (provisional): the plant sees and prints the client's name and the site on the BL; `delivery_note()` updated, test updated. |
| 7 | Stock count correction (owner only, reason mandatory, step-up, one `count_adjustment` movement, listed on the stock screen) and the load-cancellation screen (owner and partner, reason, step-up). |

## Deviations and things to decide
- **Decision 79 exception** (migrations create structure only): 0053 and 0055 convert existing rows (derived, system actor, audited). Listed in the structure test with its reason, and noted in DECISIONS 79. Both ran against a copy of the dev database first (72 receipts converted, 6 thresholds).
- Point 4 "billed at the order's price" needed no billing change: invoices already bill every live load at the order's unit price; the confirmation records the owner's acceptance, it does not gate the invoice.
- New permissions (owner unless noted): `cash.decide`, `deliveries.excess_read` (owner, partner, support), `deliveries.excess_confirm`, `stock.count`. New sensitive actions (fresh 2FA): `cash.apply_option`, `load.confirm_excess`, `load.cancel`, `stock.adjust`. Added `next.config` `NEXT_DIST_DIR` so an e2e build never touches the directory a dev server uses.
- Not done: the nightly recompute job (the system role has no read path to money tables), options for worst-case-only deficits, TRUCK-OVERCAPACITY and RECON-GAP rules, forecast snapshots. The PDF library and the accountant's layout stay open questions.
- The dev database was migrated up to 0057 (57 migrations), never reset. `db:scenario` was not re-run: its data already holds the black day of 5 November.

## Update 2026-10-25 (end of the day)
Committed: the work above is in nine commits (rules engine and dashboard, office doors, partial receipts, loads above the order, one threshold source, the BL client name, stock count and load cancellation, invoice payment state, then a commit that finishes the mechanical split). The commits were cut by hand from one working tree, so the eight before the last one are **not each buildable on their own**; the last one is the verified state. The dev database is migrated (63 migrations) and `db:scenario` was re-run (it now also seeds the operations second wave, docs/checkpoints/CP-OPS-4.md). The full pipeline was re-run: lint, prettier, typecheck, 2 757 tests, production build, audit chain (9 364 events) and the e2e suite; the review of the full e2e run found the four defects listed in CP-OPS-4 and fixed them.

**Office doors, confirmed.** After migration 0052 no price, total, client or load reaches an office-context call: `invoice_source` is gone; `create_order`, `create_quote` and `create_invoice` return a code (and an id for orders and quotes) and nothing else; `resolve_selling_price` answers owner and system only; office has no INSERT policy on the document tables; the price checks of the guard triggers run after row-level security. The tests are in `tests/ledger-exposure.int.test.ts` ("review of CP-L4": the reviewed function list, no price in any result of the creators by a regex over the whole result, probes with unknown codes audited and locked out after ten, direct inserts refused with 42501 and no amount in the message, partner, plant and support refused) and `tests/office-doors-parity.int.test.ts` (the SQL creators equal the TypeScript domain to the centime).
