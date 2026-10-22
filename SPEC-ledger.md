# Spec: `ledger`

Status: DRAFT · Depends on: `master-data`, `clock` · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
Record every money commitment and movement exactly: client orders with their payment plan, internal invoices, payment instruments through their full lifecycle, purchases and supplier payments, and the caisse/bank accounts — with integer centimes, no deletion, and corrections only by reversing entries (R6–R12). This is the factual base the rules engine projects from.

## 2. Data model

### Orders and plans
| Table | Key columns | Notes |
|---|---|---|
| `order` (`commande`) | id, code `CMD-YYYY-nnnnn`, client_id, site_id, zone_id, concrete_type_id, volume_l, delivery_date, delivery_window (optional), selling_price_id, unit_price_ht_centimes (per m³), vat_rate_bp (basis points, from parameter `vat_rate_bp`, default 2000 = 20%, ✅ A4), total_ht, total_vat, total_ttc, brought_by_user_id (owner/partner — ✅ D3), status (`confirmed`/`partially_delivered`/`delivered`/`cancelled`), entered_via (`form`/`ai_assisted`), reverses_id | Totals computed by domain code, stored, re-verified by test |
| `payment_plan_item` (`echeance`) | id, direction (`in`/`out`), order_id / purchase_id, method (`cash`/`cheque`/`lcn`/`transfer`/`advance`/`installment` — 🟡 D27), amount_centimes, due_date, seq, status (derived: `pending`/`covered`/`partially_covered`/`overdue`/`cancelled`), reverses_id | Σ items = document TTC, enforced |

### Instruments and money
| Table | Key columns | Notes |
|---|---|---|
| `payment_instrument` | id, direction, method (`cash`/`cheque`/`lcn`/`transfer`), counterparty (client_id / supplier_id), amount_centimes, instrument_no (cheque/LCN number), bank_name, issue_date, written_date (date on cheque/LCN), status, regularization_deadline, reverses_id | Lifecycle below |
| `instrument_event` | id, instrument_id, event (`received`/`issued`/`deposited`/`cleared`/`bounced`/`regularized`/`disputed`/`cancelled`), at_date, money_account_id, note, by_user_id | Append-only; `status` on instrument = last event (cached, recomputed by service) |
| `allocation` | instrument_id, payment_plan_item_id / invoice_id, amount_centimes | One instrument can cover several échéances and vice versa |
| `money_account` | id, kind (`caisse`/`bank`), label, bank_name | Seed: 1 caisse + 1–2 bank accounts |
| `money_movement` | id, money_account_id, date, amount_centimes (signed), source (`instrument_event`/`opening_balance`/`transfer`/`expense`/`reversal`), source_id, reverses_id | Only cleared money; the real-cash ledger (R9) |
| `opening_balance` | entity (account/client/supplier/component), amount or qty, as_of, entered_by | OQ9 — fake values in pilot |

Instrument lifecycle (R10, 🟡 D28):
```
incoming: received ──► deposited ──► cleared
                          │
                          └──► bounced ──► (30-day window) ──► regularized | disputed
outgoing: issued ──► cleared | bounced
cash / transfer: received|issued ──► cleared (same day)
any non-final state ──► cancelled (reversing entry)
```
- `cleared` creates a `money_movement` (incoming +, outgoing −) on the account.
- `bounced` (law 71.24): sets `regularization_deadline = bounced_date + 30 days` (R25); the allocation is reversed so the échéance becomes uncovered/overdue again; a *bounced* bank fee can be entered as an expense.
- `regularized` requires a new instrument (cash/transfer/cheque) covering the amount; `disputed` closes the window and flags the client 🔴.
- Post-dated: `written_date > issue/received date`. Incoming post-dated = *probable* until cleared; outgoing post-dated = liability presentable at any time (R11, 🟡 D29) — used by the forecast, not stored differently.

### Invoices (internal only, 🟡 D31)
| Table | Key columns | Notes |
|---|---|---|
| `invoice` | id, number `FA-YYYY-nnnnn` (gapless per year, 🟡 A26), client_id, invoice_date, due_date (= invoice_date + client terms, ≤ 120 days — R24), totals HT/VAT/TTC, ice_client, status (`issued`/`paid`/`partially_paid`/`cancelled`), credit_note_of | Model ready for future e-invoicing (ICE etc.) |
| `invoice_line` | invoice_id, delivery_id, volume_l, unit_price_ht, line_ht | From delivered loads |

Cancellation of an invoice = credit note (`avoir`) referencing it; the number is never reused.

### Purchases
| Table | Key columns | Notes |
|---|---|---|
| `purchase` | id, code `ACH-YYYY-nnnnn`, supplier_id, order_date, supplier_invoice_no, supplier_invoice_date, due_date (69-21), totals, status, reverses_id | |
| `purchase_line` | purchase_id, component_id (nullable for services like transport/fuel), purchase_unit_id, qty, unit_price_ht, line_ht | Stock effect via `operations` on receipt |
| `purchase_receipt` | id, purchase_id, received_date, received_by | Triggers stock increase (R2) |

Supplier payments are outgoing `payment_instrument`s allocated to purchase `payment_plan_item`s.

## 3. Behaviour
- **Order entry (≤ 1 min target, BRIEF §6):** one screen: client (search by name/code), site, type, m³, date, price prefilled from `resolveSellingPrice`, payment plan presets ("comptant", "50% avance + 50% à la livraison", "3 échéances 30/60/90", "chèque à 30 j", custom). Totals and échéance amounts computed by code; last item absorbs rounding so Σ = TTC exactly.
- **Corrections (R12):** "Annuler" creates a reversing record (`reverses_id` set, negated amounts / `cancelled` status) + optional replacement; both audited, reason mandatory. Original rows never change except cached status.
- **Price override** on a single order (deviating from the resolved price) requires owner/partner and a mandatory reason (✅ A27); office can only use the resolved list/client price.
- **VAT** is never hard-coded: the order takes the current `vat_rate_bp` parameter at creation and stores it, so a later parameter change does not alter existing documents.
- **Statuses** of échéances are derived from allocations + dates (via `clock.today()`): `overdue` when due_date < today and not covered.
- **Cash entry** of a received cash payment = instrument `received` + `cleared` same day into caisse.
- **Deposit**: a batch action "Remise en banque" deposits selected cheques/LCN to a bank account on a date.

## 4. Permissions
Owner/partner W everything; office W on orders, instruments, invoices, purchases (no margins, no account balances totals beyond what a document shows — 🟡 A9); plant R on order operational fields only. Reversals of entries older than 2 days require owner/partner (🟡 parameter `reversal_window_days` = 2).

## 5. Acceptance criteria
- **AC-LED-01** Order 120 m³ B25 at 780,00 MAD HT/m³, VAT 20% → HT 93 600,00, VAT 18 720,00, TTC 112 320,00; plan 20/40/40 → 22 464,00 / 44 928,00 / 44 928,00; Σ = TTC (property test: for any amounts and splits Σ items = TTC exactly).
- **AC-LED-02** Saving a plan whose Σ ≠ document TTC is rejected.
- **AC-LED-03** No code path or DB grant allows DELETE on `order`, `payment_plan_item`, `payment_instrument`, `instrument_event`, `money_movement`, `invoice`, `purchase`; cancelling creates a reversing row and an audit event with reason.
- **AC-LED-04** Lifecycle: illegal transitions (e.g. `cleared → bounced`, `received → cleared` for a cheque without deposit) are rejected; `cleared` writes exactly one `money_movement` with the correct sign.
- **AC-LED-05** Bouncing a cheque received from CLT-08 on D3 sets deadline D3+30, un-covers its échéances, and marks them overdue if past due.
- **AC-LED-06** Regularizing requires a covering instrument; the window closes; history shows both instruments.
- **AC-LED-07** Real cash (Σ cleared movements) and "total incl. uncleared" (real + incoming instruments `received`/`deposited`) are both available per account and in total (R9).
- **AC-LED-08** Invoice numbers are gapless per year under concurrent creation (10 parallel creations → 10 consecutive numbers); a cancelled invoice yields a credit note, number unchanged.
- **AC-LED-09** Invoice due date defaults to invoice date + 60 days; > 120 days is rejected (R24).
- **AC-LED-10** An office user creates an order with a 2-item plan in the form in < 120 s without AI (timed e2e script — S2 baseline).
- **AC-LED-11** All amounts in DB are integer columns; lint/type check forbids `number` arithmetic on `Centimes` outside `lib/money.ts` helpers.
- **AC-LED-12** An office user changing the unit price of an order is refused; owner/partner without a reason is refused.
- **AC-LED-13** Changing parameter `vat_rate_bp` to 1400 affects only orders created afterwards; no literal VAT rate appears in domain code (grep check).

- **AC-LED-14** A post-dated cheque can be deposited (incoming) or cleared (outgoing) before its `written_date`: the event is accepted and flagged `early`; on or after the written date it is not flagged.
- **AC-LED-15** An invoice's issuance deadline is the last day of the delivery month (R24); the derived legal-deadline read model lists receivable and payable due dates and issuance deadlines.
- **AC-LED-16** A purchase's due date defaults to supplier invoice date + 60 days and > 120 days is rejected (R24); a supplier payment is an outgoing instrument allocated to the purchase's plan items.
- **AC-LED-17** Reversal window: an office user can reverse an entry within `reversal_window_days` (2); an older entry is refused to office and accepted for owner/partner with a reason.
- **AC-LED-18** An archived client or supplier cannot be selected on a new order or purchase; existing documents still show it (completes AC-MD-05).

## 6. Assumptions relied on
✅ D4, D5, D9, D14; 🟡 D27 (methods), 🟡 D28 (lifecycle), 🟡 D29 (early presentation), 🟡 D31 (internal invoices), 🟡 D34 (reversals), ✅ A4 (VAT 20% in simulation, configurable), ✅ A9, ✅ A27, 🟡 A26, OQ7 (VAT), OQ9 (opening balances).
