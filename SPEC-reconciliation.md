# Spec: `reconciliation`

Status: DRAFT · Depends on: `operations`, `platform-security` · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
At the end of each delivery day, compare three independent records — what we planned (orders), what the plant says it produced (plant software export or manual totals), what left on BL — plus theoretical vs physical stock, and show every gap above tolerance with its most likely source and the entries/people involved (R19–R21). The intentional double entry is the control (✅ D15); no plant integration in MVP.

## 2. Data model

| Table | Key columns | Notes |
|---|---|---|
| `plant_import` | id, business_date, file_name, file_sha256, mapping_profile_id, row_count, status (`previewed`/`committed`/`reversed`), imported_by | Same file hash cannot be committed twice |
| `plant_mapping_profile` | id, name, column map jsonb (date, recipe code, volume, optional batch id/time/truck), recipe_code_map jsonb (plant code → concrete_type_id), volume_unit (`m3`/`L`), date_format, decimal_separator | Saved per plant software (OQ3, 🟡 D54) |
| `plant_batch` | id, import_id, business_date, plant_recipe_code, concrete_type_id, volume_l, batch_ref, batched_at, truck_ref | One row per batch |
| `plant_manual_total` | business_date, concrete_type_id, volume_l, entered_by | Alternative to import |
| `physical_count` (`inventaire`) | id, business_date, component_id, qty_base, counted_by, counted_at | Plant operator, daily |
| `reconciliation_run` | id, business_date, status (`open`/`gaps`/`clean`/`closed`), closed_by | Opened by `day-close` job |
| `reconciliation_gap` | id, run_id, kind (`planned_vs_bl`/`plant_vs_bl`/`stock_vs_count`), concrete_type_id / component_id, expected, actual, gap, gap_pct, over_tolerance, likely_sources jsonb, linked_entry_ids jsonb, explanation_id (AI, optional) | |

## 3. Behaviour

### Import (🟡 D54)
- Upload CSV or XLSX (≤ 5 MB, ≤ 5 000 rows). Parsing in a sandboxed server function: values only, formulas never evaluated, no macros, no external links; cell text treated as data.
- Mapping wizard on first import (choose columns, map plant recipe codes to concrete types, unit, date format), saved as a profile; later imports reuse it.
- Preview: rows parsed, rows rejected with reason (unknown recipe code, bad date, negative volume), totals per type. Commit only after explicit confirm. Duplicate batch_ref within the same date is rejected.
- Reversal of a committed import (wrong file) = `reversed` status + reversing rows; audited.
- Manual totals per type are the fallback when no file is available.

### Three-way comparison (R19), per business date × concrete type
- planned = Σ volume of orders with delivery_date = d (not cancelled)
- plant = Σ plant_batch (or manual total)
- bl = Σ delivered volume (loads, minus returned volume)

Gaps: `planned_vs_bl` (missed / extra deliveries), `plant_vs_bl` (produced but not delivered, or delivered without production record). Tolerance for volumes: `volume_tolerance_l` (default 500 L ≈ ½ m³, 🟡).

### Stock vs count (R20)
- theoretical(c, d) = Σ stock_movement up to end of d. gap_pct = (count − theoretical) / theoretical.
- |gap_pct| > `stock_tolerance_pct` (2%, 🟡) ⇒ over tolerance → `RECON-GAP` alert (🔴) via rules-engine.
- After the run is closed, a `count_adjustment` movement aligns theoretical to physical (the gap stays recorded forever).

### Attribution (R21) — deterministic heuristics, ordered
Each heuristic that matches adds a `likely_source` with the evidence entries and the people who made them:
1. `plant_vs_bl` ≠ 0 and same truck/time pattern → "chargement non saisi" or "BL non retourné" (plant/office entry), lists the loads and the batches without a matching load.
2. `planned_vs_bl` < 0 with no cancellation → "livraison manquée" (order + who planned it + truck status that day).
3. Stock gap with plant ≈ bl → "écart de dosage / pesée" (recette vs plant batches of that type, plant operator).
4. Stock gap matching a purchase receipt quantity ±5% → "réception non saisie ou en double" (receipt + who entered it).
5. Stock gap with returned concrete that day → "retour béton".
6. None matched → "source inconnue" + all entries of the day for that component.
Ranking = order above, then larger explained share of the gap. AI (optional) only rewrites this into a sentence.

## 4. Permissions
Plant: import, manual totals, physical count, view runs. Owner/partner: view all, close runs. Office: none (🟡 D33).

## 5. Acceptance criteria
- **AC-REC-01** Importing a CSV with a saved profile parses date, recipe, volume; unknown recipe codes and malformed rows are listed and excluded; nothing is stored until confirm.
- **AC-REC-02** Re-importing the same file (same hash) is refused; a file with a cell `=HYPERLINK(...)` or `=1+1` is stored as text, never evaluated.
- **AC-REC-03** For a day with planned 82 m³, plant 82 m³, BL 80 m³ of B20, the run shows a `plant_vs_bl` gap of 2 m³ with source "chargement non saisi / BL non retourné" and the batches lacking a load.
- **AC-REC-04** Cement theoretical 40 000 kg vs count 38 760 kg (−3.1%) creates a gap over the 2% tolerance, a 🔴 `RECON-GAP` alert, and lists the day's cement movements with their authors.
- **AC-REC-05** A gap of −1.5% is shown but does not alert.
- **AC-REC-06** Missing plant import or count at `day-close` shows "à compléter" for the plant operator (in-app task), not a gap.
- **AC-REC-07** Closing a run writes `count_adjustment` movements; the gap record remains unchanged and audited.
- **AC-REC-08** Manual totals produce the same comparison as an import with the same totals.
- **AC-REC-09** Office role gets 0 rows from reconciliation tables (RLS test).

## 6. Assumptions relied on
✅ D6, ✅ D15; 🟡 D54 (CSV/XLSX import with mapping), tolerances (2% stock, 500 L volume) 🟡, attribution heuristics 🟡 (to validate with the owner), OQ3 (real export format).
