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
