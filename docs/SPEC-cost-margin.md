# SPEC — Cost and margin engine (D236, D237)

Status: DRAFT for Ali's approval (T14, 15 Nov 2026). Docs only. **Every number below is an ASSUMPTION (set A1) or an invented training value. No real recipe, price, invoice or supplier figure appears here or anywhere in git.**
Source: D236, D237, `docs/LEAD-HANDOFF.md` §4 (assumption set A1, plant software structure), `docs/reviews/SMS-GPS-STOCK-INVENTORY-2026-11-15.md` §5.

## 1. Purpose
Show, per m³ sold, the COST, the SELLING PRICE and the MARGIN, by concrete class and by discharge method, so the owner sees what each class really earns. Money is computed by deterministic code only, stored as integer centimes; AI never computes amounts.

## 2. Scope
In: price grid (class × discharge method), versioned purchase prices, cost per m³ in five blocks, three margins, cost snapshot frozen per BL, fuel per trip and per hour, visibility rules, the "Marges" screen, assumption mode, fictitious recipes.
Out: real figures (arrive later through data screens), tax/VAT rules beyond HT display, accounting exports, AI explanations.

## 3. Vocabulary (must stay separate fields, linked explicitly)
- **Commercial class** (B20, B25…): what the client buys and what the price grid uses.
- **Discharge method:** `GOULOTTE` (mixer alone, direct discharge) or `POMPE` (mixer + pump truck).
- **Industrial recipe code** (plant software code such as "B/25 POMPE"): what the plant batches. Several codes may serve one class (the real plant has B25 in both POMPE and GOULOTTE variants with different doses; the reason is an open question). A mapping `(class, method, plant) → recette` is explicit data; the BL records the recette version used.

## 4. Price grid
One selling price per m³ per (class, method, effective_from), HT, in centimes. POMPE price **includes the pump service**; the pump truck is **not invoiced separately**, so there is no separate pump invoice line. Invoice line amount = invoiced m³ × price per m³ for the method on the order/BL. Table `price_grid` (insert-only, versioned by date; plant optional for later). Confirmation rules of 13 Nov (price confirmed by owner, office_sales, app_admin) stay as decided and are not changed here.
Assumption A1 seed (illustrative, GOULOTTE, HT): B10 600, B15 660, B20 740, B25 820, B30 890, B35 930 DH/m³; POMPE = GOULOTTE + 50 DH/m³ (flag "assumption").

## 5. Cost per m³ (five blocks)
Cost/m³ = MATERIALS + DELIVERY + PUMP + PLANT + OVERHEADS.
1. **Materials** = Σ over recette lines (dose per m³ × purchase price delivered to the plant at the BL date). Doses in kg/m³ (water L/m³); prices per tonne converted by integer arithmetic, one rounding per line (half away from zero). Prices come from versioned `purchase_price` (exists, `0024`), extended with a "delivered to plant" figure: price + transport (by the supplier invoice or from the hauler cost per tonne in T12).
2. **Delivery** = diesel for the trip + driver cost + maintenance/tyres/amortisation, per m³ delivered (cost of the trip ÷ invoiced m³ of that trip).
3. **Pump** (POMPE only) = diesel per hour × hours + operator + maintenance/amortisation, per m³ pumped. Pump hours come from the pump job (`pump_job_event`: arrival → pumping_started → pumping_ended → left).
4. **Plant** = electricity, loader diesel, labour, maintenance, losses, per m³ produced (a monthly pool ÷ monthly m³, or a configured rate per plant while data is missing).
5. **Overheads** = general overheads allocated per m³ (rate per month or per m³; allocation basis is an open question).
All rates are **data** in versioned tables (`cost_rate`: key, unit, value in centimes, effective_from, plant?, `is_assumption`, source note), never constants in code.

## 6. Three margins
Per BL line (and aggregated by class, method, plant, client, month):
- **M1 on materials** = price − materials.
- **M2 after delivery** = price − materials − delivery (− pump for POMPE).
- **M3 full** = price − all five blocks.
Each shown as amount per m³, total, and basis points of price (integer bp; rounding half away from zero). Totals are sums of per-BL integers, never a recomputation from averages.

## 7. Cost snapshot per BL
When the plant creates the BL, a `bl_cost_snapshot` row (insert-only) freezes: recette version id, doses used, purchase price per component (and its version id), fuel price, each rate used (version ids), discharge method, class, invoiced m³ and the computed blocks in centimes. Later price changes never rewrite history. A correction is a **reversing snapshot** plus a new one (never an update or delete), linked to the BL reversal when the load is cancelled. Snapshot creation is part of the same transaction as the BL (same door); if a required rate is missing, the BL still posts and the snapshot records `incomplete = true` with the missing keys listed (assumption fallback is explicit, never silent).

## 8. Fuel per trip and per hour
Exists: `fuel_fill` per truck, the plant tank, tank opening, day-close variance lines (`0062`, `0104`, `0107`).
Add: litres per trip = configured rate per truck kind (mixer, assumed 22 L per 30 km round trip) until measured; measured values replace it: litres between two fills ÷ trips or hours (mixer by trip and km, pump by engine hour). Table `fuel_norm` (truck kind or truck, per_trip_l or per_hour_l or per_km_l, effective_from, is_assumption). Trip cost = litres × diesel price at the BL date (diesel price is a versioned `cost_rate`). Real consumption is compared with the norm on the day-close page (variance alert, quantity only).

## 9. Visibility
Costs, margins, snapshots, cost rates and the grid's margin view: **owner and app_admin only**. Not office_sales, plant_manager, accountant, driver, pump, partner or support unless a later numbered decision says so. office_sales continues to see the official selling price per existing role decisions. Enforcement: RLS + SECURITY DEFINER read doors that check role; no view grants; the money-visibility matrix and its test are extended (this touches money visibility: flagged in SECURITY-DEBT as "verify at the final audit"). Exports of margins are owner/app_admin only and audited.

## 10. "Marges" screen (owner/app_admin)
Filters: period, plant, class, method, client. Table by class × method: sold m³, average price, materials, delivery, pump, plant, overheads (per m³), M1/M2/M3 (amount and %), count of BLs with `incomplete` or assumption-flagged inputs. Drill-down: class → BLs → one BL's snapshot. A visible banner while any input is flagged "assumption": "Figures use assumed values" with the count and a link to the data screens. Excel export (D234) for owner. Fictitious until real data screens are filled.

## 11. Assumption mode (D237)
- Every assumed value is a row of data with `is_assumption = true` and a `source_note`; the UI and the seed label it "assumption"; no cost constant exists in application logic.
- Replacing it = inserting a new versioned row (real value, `is_assumption = false`) through a data screen, by owner/app_admin, audited.
- **Seed set A1** (not company data; web references of 15 Nov for diesel ~17 DH/L, cement national average, sand tax; the rest invented): cement CPJ 55 1 200 DH/t; gravel GI and GII 130 DH/t; sand S/C 110 and S/M 120 DH/t; water 12 DH/m³; admixture 18 DH/kg; diesel 17 DH/L; mixer 8 m³ per trip, 30 km round trip, about 22 L per trip; delivery about 68 DH/m³; pump about 40 DH/m³; plant about 40 DH/m³; overheads about 30 DH/m³; selling prices as §4. Illustrative, assumption values (recomputed 15 Nov from the A1 prices above and the §12 FX doses, before any delivered-transport add-on): materials about 589–750 DH/m³ across the five FX recipes (FX-B20-G 589, FX-B25-G 624, FX-B25-P 681, FX-B30-P 714, FX-B30-H 750), cement about 61–64 % of the materials cost. The earlier range (418–646) and the earlier "full margin about 6–16 %" were not reproducible from these inputs and are withdrawn: the full margin is whatever the doors compute from the data, never quoted from this spec.

## 12. Fictitious recipes (structure of the real plant software, invented doses)
Components keep the plant software's code scheme: 1 GI, 2 S/C, 3 S/M, 4 GII, 5 CPJ 55 (6 = duplicate cement field, left 0), 13 EAU, 15 and 16 admixtures, 17 hydrofuge admixture. Doses are kg per m³ (water L/m³). **Invented, deliberately round, not derived from any real recipe:**
| Recipe code | Class | Method | 1 GI | 2 S/C | 3 S/M | 4 GII | 5 CPJ55 | 13 EAU | 15 adm | 16 adm | 17 hyd |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FX-B20-G | B20 | GOULOTTE | 400 | 350 | 350 | 450 | 300 | 170 | 2 | 0 | 0 |
| FX-B25-G | B25 | GOULOTTE | 400 | 350 | 350 | 440 | 330 | 170 | 2 | 0 | 0 |
| FX-B25-P | B25 | POMPE | 380 | 360 | 360 | 420 | 350 | 180 | 3 | 1 | 0 |
| FX-B30-P | B30 | POMPE | 370 | 360 | 350 | 420 | 380 | 175 | 3 | 1 | 0 |
| FX-B30-H | B30 | POMPE | 370 | 360 | 350 | 420 | 380 | 175 | 3 | 1 | 2 |
The existing seed's B20/B25/B30 recettes may be extended with the POMPE/GOULOTTE variants; names carry the prefix `FX-` so no one mistakes them for real. The two "totals" of the real screens are not modelled (meaning unknown).

## 13. Data model summary (sketch)
| Table | Purpose |
|---|---|
| `discharge_method` (enum on order line, BL) | GOULOTTE / POMPE |
| `class_method_recette` | (class, method, plant) → recette, effective_from |
| `price_grid` | selling price per class × method, versioned |
| `purchase_price` (exists) + delivered-cost extension | component price per unit, versioned |
| `cost_rate` | all diesel/labour/plant/overhead rates, versioned, `is_assumption` |
| `fuel_norm` | litres per trip/km/hour by truck kind or truck |
| `bl_cost_snapshot` (+ lines) | frozen per BL, insert-only, reversing on cancel |
| `margin_summary` view/door | owner/app_admin read-only aggregation |

## 14. Roles and RLS expectations
Writes: owner/app_admin for `cost_rate`, `fuel_norm`, price grid (office_sales may confirm prices per existing rules but never sees cost). Snapshot written by the BL door (system path inside the transaction). Reads: owner/app_admin only through definer doors; plant_manager creating a BL triggers a snapshot he cannot read back. RLS FORCE; hash-chained audit on every rate change and snapshot; definer catalogue and money-visibility matrix tests updated.

## 15. Edge cases
Recipe changed after BL (snapshot protects); price missing for a component at the BL date (use latest earlier, else incomplete); POMPE BL without pump job (cost pump = 0, flagged); several BLs on one trip (cost split by m³); partial load/refused load (cost incurred, revenue per cancellation policy); client with negotiated price (margin on the actual line price, grid is the default); free-of-charge load; rounding drift (sum of line integers is authoritative); class with two industrial recipes (explicit mapping); negative margin (shown red, not hidden).

## 16. Test plan
Unit: block arithmetic and rounding, three margins, conversion t→kg, bp rounding, split by m³. DB: snapshot immutability (no UPDATE/DELETE grant), snapshot in the BL transaction, reversal on cancel, incomplete flag. Authorization: every non-owner/app_admin role is refused on every read door and export (negative sweep asserts refusal). Seed test: A1 produces the illustrated ranges; every seed row has `is_assumption = true`. Static test: no cost constant in `src/` outside tests and seed files. E2E (fictitious): owner opens Marges, drills to a BL; office_sales cannot reach it.

## 17. Open questions for Ali / owner (real details to bring later)
Real purchase prices and supplier invoices; real selling grid and pump supplement; why B25 POMPE ≠ B25 GOULOTTE; which recipe code the operator uses per load; recipe units (kg/m³, additive unit and brand) from a known-volume production report; meaning of the two totals; fuel measurement method and litres per trip/hour; wages, distances, plant costs; overhead allocation basis; confirmation that costs are owner/app_admin only; whether the owner wants a margin alert threshold.

## 18. Proposed migration / task order
1. M-A: `discharge_method` on order line/BL + `class_method_recette` + `price_grid` (+ tests).
2. M-B: `cost_rate`, `fuel_norm`, delivered-price extension, data screens (owner/app_admin), A1 seed with fictitious `FX-` recipes.
3. M-C: `bl_cost_snapshot` in the BL door + reversal.
4. M-D: margin read doors and the "Marges" screen; money-visibility matrix extended.
5. M-E: fuel per trip/hour measured vs norm; pump hours from pump jobs.
Debt rows to add when built: money-visibility matrix extension; assumed values present in seed (final audit verifies none is treated as real).
