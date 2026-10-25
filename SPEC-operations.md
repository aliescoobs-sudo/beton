# Spec: `operations`

Status: DRAFT · Depends on: `ledger`, `master-data` · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
Track what physically happens: each truck load (BL) that leaves the plant for an order, the theoretical stock of every component (down by recette on delivery, up on receipt), the margin each delivery makes, and whether the trucks can do the day's planned loads.

## 2. Data model

| Table | Key columns | Notes |
|---|---|---|
| `delivery` (`chargement` / BL) | id, bl_no `BL-YYYY-nnnnn`, order_id, truck_id, volume_l (≤ truck capacity — R3), loaded_at, recette_id (resolved at load), status (`loaded`/`delivered`/`returned_partial`/`cancelled`), returned_volume_l, bl_returned_at, bl_returned_by, created_by (plant — ✅ A11), reverses_id | |
| `stock_movement` | id, component_id, date, qty_base (signed int), source (`delivery`/`receipt`/`count_adjustment`/`opening`/`reversal`), source_id, reverses_id | Theoretical stock = Σ movements |
| `load_plan` (derived, not stored) | date, order_id, planned_loads = ceil(volume_l / capacity_l), trip_min | Computed by domain |

## 3. Behaviour

### Deliveries
- Plant screen "Chargements du jour": orders scheduled today (type, m³ remaining, site/zone — no prices), one tap to create a load with truck + m³ (default = min(remaining, truck capacity)).
- Creating a load writes stock movements: for each recette line, `−qty_per_m3 × volume_l / 1000` (R1, `mulDivRound` on quantities). Returned concrete (`returned_partial`) does **not** give components back (concrete is lost) but records the returned volume for reconciliation and margin.
- **Signed-BL return (✅ A11):** whoever receives the signed BL — plant operator or office — records its return (date, returned volume if any). Recording is allowed only while `bl_returned_at` is null; the update is a conditional `UPDATE … WHERE bl_returned_at IS NULL` (plus a check in the service), so a second attempt by anyone fails with "BL déjà enregistré par <user> le <date>". A correction after recording = reversal by owner/partner. The audit log shows who recorded it.
- Order status moves to `partially_delivered` / `delivered` from Σ delivered volume.
- 90-min rule (R4, 🟡 D32): warning on load creation when zone one_way_min + unloading_min > `concrete_limit_min`.

### Stock
- Receipt of a purchase writes `+qty × factor_to_base` per line (R2).
- Projected stock per component per day over the horizon = current theoretical stock + scheduled receipts (purchases not yet received, with expected date) − Σ planned consumption of confirmed orders (remaining volume × recette). Exposed as a pure function for `rules-engine` (R5).
- Physical-count adjustments are written by `reconciliation` as `count_adjustment` movements (after the gap is recorded).

### Margin (R13)
`margin = unit_price_ht × delivered m³ − component cost (recette × purchase price in force at load date) − transport cost (if known, else null and flagged "partielle")`. Pure domain function; shown only to owner/partner.

### Truck capacity (R22–R23, 🟡 D45)
- `trip_min(zone) = 2 × one_way_min + unloading_min (30) + loading_min (10, 🟡 A18)`.
- Daily capacity minutes = Σ available trucks (not in breakdown that day) × `working_min` (600, 🟡 A18).
- Required minutes = Σ over the day's orders of planned_loads × trip_min(zone).
- Conflict when required > capacity, or planned loads of any single order need more trucks-in-parallel than exist within the 90-min window (not modelled in MVP — only the minutes check).

## 4. Permissions
Plant W on deliveries and receipts-as-quantities; office R on deliveries and records signed-BL return when it receives it (✅ A11); owner/partner W; margins owner/partner only.

## 5. Acceptance criteria
- **AC-OPS-01** A load > truck capacity is rejected (R3).
- **AC-OPS-02** A 8 m³ B25 load with recette cement 350 kg/m³ writes −2 800 000 g cement and the matching lines for every component; property test: Σ consumption over loads = recette × Σ m³ within ±1 base unit per load.
- **AC-OPS-03** Purchase receipt of 30 t cement increases stock by 30 000 000 g.
- **AC-OPS-04** Cancelling a load writes reversing stock movements; original rows unchanged.
- **AC-OPS-05** Projected stock for day D includes confirmed orders up to D and scheduled receipts up to D; a new order immediately changes the projection.
- **AC-OPS-06** Margin for 8 m³ at 780 MAD HT/m³ with component cost known and transport unknown is computed and marked "partielle"; office and plant responses contain no margin.
- **AC-OPS-07** Truck capacity: 5 trucks × 600 = 3 000 min; with one truck in breakdown (2 400 min) and planned loads requiring 2 850 min, the capacity check reports a conflict of 450 min.
- **AC-OPS-08** Creating a load to Oued Laou (60 + 30 = 90 min) with limit 90 gives no warning; with limit 85 gives a warning (parameter-driven).
- **AC-OPS-09** Plant screen shows no price, total, client phone or payment data (DOM + API assertion).
- **AC-OPS-10** Plant records a signed-BL return; a subsequent attempt by office (or plant again) is refused with who/when of the first recording; two concurrent attempts result in exactly one recorded return; the audit event names the recorder.

- **AC-OPS-11** (DECISIONS 82) Each delivery has a printable delivery note (bon de livraison, PDF, fr; Arabic header where the font allows): BL number, date, our legal mentions, client code and name, site, concrete type, volume, truck, loaded time, signature boxes. It carries no price, total or payment data and can be printed by office, plant, owner, partner and support; the print is audited. Built on the document kit of ledger L30.

## 6. Assumptions relied on
✅ D7; 🟡 D32 (90 min, 30 min unloading, 8 m³), 🟡 D45 (simple truck check), 🟡 D53 (zones), ✅ A11 (who creates/returns BL), 🟡 A18 (loading 10 min, working 600 min), OQ6.

## 7. Additions (2026-10-25, the owner moves operations before further money screens)
Status: DRAFT, built as tasks O9–O15 (tasks/plan-operations-2.md, checkpoint note docs/checkpoints/CP-OPS-PLAN-2.md). Quantities only, except where a line says "money": those parts are owner and support only (DECISIONS 81). No amount is computed by AI; every figure below comes from deterministic code over stored facts.

### 7.1 New parameters (all 🟡 to confirm with the plant)
`loading_min` 10 (A18), `return_extra_min` 10 (washing the drum and handing back at the plant, added to the way back), `working_min` 600 (A18), `day_start_min` 420 (07:00), `consumption_tolerance_bp` 200 (R20: 2 %), `reorder_margin_days` 2 (safety days on top of a supplier's lead time). Existing: `unloading_min` 30, `concrete_limit_min` 90, `purchase_lead_days`.

### 7.2 Data model
| Table | Key columns | Notes |
|---|---|---|
| `driver` | id, code `CH-nn`, name, status (`active`/`archived`) | Name only (R26). Owner and partner write; operations roles read. |
| `trip_plan` (rotation) | id, trip_date, order_id, seq (1…n per order and day), truck_id, driver_id, volume_l, load_min, depart_min, arrive_min, unload_end_min, back_min (minutes from midnight), created_by | Insert-only. Times are stored facts (a later parameter change does not rewrite a saved plan). Database guard: truck active **and** available on the date by the breakdown log, driver active, volume ≤ truck capacity, order live. |
| `trip_plan_cancellation` | trip_id (unique), reason, created_by | Replanning a day cancels its live rotations (reason `replanned`) and inserts the new ones. |
| `trip_event` | id, trip_id, step (`loaded`/`departed`/`arrived`/`unloading_started`/`unloading_finished`/`back`), at, delivery_id (only on `loaded`), created_by | Insert-only, unique per trip and step, steps in order, never before the previous one. `loaded` is the existing one-tap load (it creates the BL and links it). |
| `delivery_loss` | id, delivery_id (unique), volume_l (≤ the load), reason (`rejected_by_client`/`returned_unused`/`too_old`/`quality`/`other`), note, created_by | Insert-only (O14). |
| `fuel_fill` | id, truck_id, filled_on, litres_ml, odometer_km (optional), source (`tank`/`station`), created_by | Quantities (O13). Insert-only. |
| `fuel_purchase` | id, purchased_on, litres_ml, total_centimes, supplier_id (optional), created_by | **Money.** Insert-only, owner writes, owner and support read. |
| `supplier.lead_time_days` | integer, optional | Calendar days from order to receipt (O12); falls back to `purchase_lead_days`. |

### 7.3 Behaviour
**Daily dispatch (O9).** For a date, each live order due that day (remaining volume > 0) is split into rotations of at most the truck's capacity. Pure domain `planDispatch`: orders in code order, each rotation takes the truck that is free first (ties: the smallest truck that carries what is left), drivers are paired to the available trucks in code order. Rotation timeline: loading `loading_min`, drive out `zone.one_way_min`, unloading `unloading_min`, drive back `zone.one_way_min + return_extra_min`; the first rotation of a truck starts at `day_start_min`, the next at the truck's back time. Pure `checkDispatch` validates any plan (the proposal or one edited by hand) and returns conflicts, shown on the screen: `TRUCK_BROKEN` (blocking: refused by the database too), `TRUCK_OVERLAP`, `DRIVER_OVERLAP`, `NO_TRUCK`, `NO_DRIVER`, `OVER_CAPACITY` (blocking), `PAST_WORKING_DAY` (back after `day_start_min + working_min`), `LONG_TRIP` (R4: unloading ends more than `concrete_limit_min` after loading ends), `ORDER_NOT_COVERED` (planned < remaining), `OVER_PLANNED`. The proposal writes nothing; a person saves it (D65). Owner, partner and plant plan; support reads.
**Trip tracking (O10).** One phone-sized screen listing the day's live rotations; one tap records the next step with the clock's time. `loaded` opens the same load as "Chargements" (BL created, stock down). Derived (never stored): waiting time on site = `unloading_started − arrived`, unloading time, round-trip time, delay against the plan, concrete age at the end of unloading (R4 actual). Plant, owner and partner record; support reads.
**Production and consumption (O11).** m³ produced per concrete type per day = live loaded volume (reversals net out). Theoretical consumption per component = Σ delivery movements (the recette in force on each load date, already stored, AC-OPS-02). Actual consumption over a period = theoretical − Σ `count_adjustment` movements dated in the period (a physical count that finds less than the books means more was used); receipts are in both sides and cancel. Variance = actual − theoretical, as a share of theoretical in basis points; **flagged** when its absolute value exceeds `consumption_tolerance_bp`. Concrete lost (O14) is part of what was produced, so it is already in the theoretical figure; the report shows it as a separate line (m³ lost per type, components it consumed). Per period (day, week, month). Quantities only: owner, partner, plant, support read.
**Days of cover and reorder (O12).** Per component, from the open orders' needs by the recette in force: the first day the projected stock reaches zero (days of cover), counted in calendar days, "beyond the horizon" when none. Reorder when cover < the supplier's lead time + `reorder_margin_days`: the suggested quantity brings the stock to the horizon's needs plus the threshold; it is a **draft purchase** (supplier, quantity, estimated date) for the owner to review and enter. Nothing is ordered by the engine. The draft carries no price for non-money roles; the estimate in money is owner and support only.
**Fuel per truck (O13).** Fills per truck (litres, optional odometer) are quantities: litres per truck and period, km, litres per 100 km, litres per m³ delivered (plant, partner read). Money: the fuel purchased in the period gives an average price per litre (Σ amount ÷ Σ litres, one rounding); cost of a truck's fuel = its litres × that price; cost per m³ delivered = that cost ÷ the truck's m³ (owner and support only).
**Returned or rejected concrete (O14).** Recorded per load with a reason, once, by plant, office, owner or partner, while the load is live. It does not give components back. It is counted as loss in the consumption report. What it does to billing is not decided here (the invoice still bills live loads at the order's price; a credit for rejected concrete is the owner's credit note), see open points.
**Sales volume analytics (O15).** m³ delivered per day, week and month, per client, per concrete type and per zone, from live loads. Quantities: owner, partner, support. Money (amount at the order's price, VAT excluded, one rounding per load): owner and support only; the partner's response has no amount field at all.

### 7.4 Acceptance criteria
- **AC-OPS-12** 7 m³ + 12 m³ + 9 m³ orders with 8 m³ trucks give 1 + 2 + 2 rotations, each ≤ its truck, volumes sum to each order; a truck in the breakdown log is never in the proposal and a manual plan using it is refused by service and database.
- **AC-OPS-13** Rotation times for a zone of 25 min with loading 10, unloading 30, extra return 10: load 07:00, depart 07:10, arrive 07:35, unloading ends 08:05, back 08:40; the next rotation of that truck loads at 08:40. Changing a parameter changes later proposals, not saved plans.
- **AC-OPS-14** Conflicts: a driver on two overlapping rotations, a truck on two, a rotation ending after the working day, a long trip, and an order not fully covered are each reported with the rotation concerned; a day with no available truck reports `NO_TRUCK` per order.
- **AC-OPS-15** Saving a plan writes insert-only rows (no UPDATE/DELETE grant), replanning cancels the old ones with a reason; office, partner-money, anonymous see nothing they should not (matrix); responses carry no price, total or client contact.
- **AC-OPS-16** Trip steps are recorded in order, once each, with the clock's time; an out-of-order or repeated step is refused by service and database; two concurrent taps record exactly one. The phone screen shows one button per rotation (the next step) at 375 px, in fr and ar.
- **AC-OPS-17** Waiting time on site, unloading time and round-trip time are derived from the events (arrived 08:10, unloading started 08:40 → 30 min); delay against the plan is shown; a skipped step leaves its figures empty, never zero.
- **AC-OPS-18** Production per type per day equals Σ live loads; a cancelled load (reversal) nets out; property test: the sum over days equals the sum over loads.
- **AC-OPS-19** Theoretical consumption equals Σ recette × m³ (B25, 350 kg/m³ cement, 8 m³ → 2 800 000 g); with a count adjustment of −56 000 g on a theoretical 2 800 000 g the variance is +2,00 % (200 bp) and is **not** flagged at tolerance 200, **is** flagged at 199; variance is per component and per period; the report and the page contain no money field and are readable by plant and partner (`expectNoFields`).
- **AC-OPS-20** Days of cover: stock 10 t, orders needing 4 t on D1, 4 t on D2, 4 t on D3 → cover 2 days (stock below zero on D3); a supplier lead time of 3 days with margin 2 triggers the suggestion; the draft quantity and supplier are computed by the domain function and equal on screen; a supplier without a lead time uses the parameter.
- **AC-OPS-21** The reorder draft is a draft: nothing is inserted in `purchase` until the owner enters it; plant and partner see no price in the suggestion.
- **AC-OPS-22** Fuel: litres per truck and period, litres per 100 km (odometer difference), litres per m³ delivered are quantities readable by plant and partner; cost per litre = Σ purchases ÷ Σ litres; cost per m³ for a truck = litres × price ÷ m³, to the centime by property test; plant, partner and office responses contain no money field; owner and support read the cost; `fuel_purchase` is a money table (support read audited, hidden audit rows).
- **AC-OPS-23** A rejection is recorded once per load with a reason and a volume ≤ the load; a second is refused; a cancelled load cannot be marked; the volume appears as loss in the consumption report for that day and type without changing the theoretical consumption.
- **AC-OPS-24** Analytics: m³ per day, week (ISO) and month per client, type and zone from live loads, equal to Σ loads; for owner and support the same query gives the amount (volume × the order's unit price, HT, one rounding per load); partner gets quantities and no amount field; plant, office and anonymous get nothing.
- **AC-OPS-25** Every screen above renders in fr and ar, at 375 and 1280 px, with Latin codes isolated, no CSP violation (e2e).

### 7.5 Assumptions relied on
🟡 all the parameters of 7.1; 🟡 one driver per truck per day (paired in code order; hand edits allowed); 🟡 fuel filled at a station is priced at the period's average purchase price; 🟡 rejected concrete is still billed unless the owner issues a credit note; ✅ A11, D65, DECISIONS 81.
