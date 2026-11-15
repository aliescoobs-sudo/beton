# SPEC — Stock engine gaps (D233)

Status: DRAFT for Ali's approval (T14, 15 Nov 2026). Docs only: no migration, no code. Fictitious data only. Process mode D230: no per-task review; every shortcut gets a row in `docs/SECURITY-DEBT.md`.
Source: D233, `docs/LEAD-HANDOFF.md` §4/§8, `docs/reviews/SMS-GPS-STOCK-INVENTORY-2026-11-15.md` §5 (evidence file:line there).

## 1. Purpose
The stock engine already exists (recipes per m³ per plant, signed insert-only `stock_movement`, consumption written when the plant creates the BL, reversal on cancel, two-step receipts with 2 % variance, thresholds, fuel tank). This spec closes the six gaps found by the inventory so that the original intent of the project works end to end: what leaves, what arrives, what is missing, what must be requested.

## 2. Scope
In: (1) count tolerance and variance alert; (2) plant_manager right to decide on counts; (3) reorder request plant_manager → office_purchases; (4) hook for hauler receipts (T12); (5) import from the plant batching software (structure only); (6) rule for refused loads and component return; (7) the invariant on who decrements stock.
Out: the hauler module itself (T12), the real import adapter (needs real exports, later), any UI redesign (UX track D234), costs/margins (`SPEC-cost-margin.md`).

## 3. Invariant (non-negotiable, tested)
**Stock is decremented only by the plant's BL** (`createLoadInTx` → `insertLoadRows`, one `stock_movement` per recette line). It is never decremented by a driver's "loaded" tap, by an SMS code 2, by a GPS event or by an office edit. `loaded` stays a "declared" fact (T9, `0209`). Corollaries: SMS/GPS ingestion code has no grant on `stock_movement`; a test asserts that writing a `loaded` stage leaves the movement sum unchanged; a cancelled load reverses by equal and opposite movements (existing).

## 4. Gap 1 — Count tolerance and alert
Today: `count_adjustment` written by owner/app_admin, mandatory reason, no tolerance, no alert; day close lists counted components as blocking `stock_variance`.
Proposal:
- **Tolerance as data:** a versioned, insert-only table `stock_count_tolerance` (plant_id nullable = default, component_id nullable = default, tolerance in basis points of the theoretical level, plus an optional absolute floor in base units, effective_from, set_by, reason). Latest effective row wins, most specific wins (plant+component > component > plant > global). Seed (assumption, labelled): 200 bp for bulk (cement, sand, gravel), 0 for admixtures counted by container, floor 0.
- **Variance figures** computed by deterministic code from integers: theoretical = sum of movements at the count instant; variance = counted − theoretical (base units); ratio in bp = variance × 10000 / theoretical, rounded half away from zero; theoretical ≤ 0 → ratio "n/a" and always an alert.
- **Alert:** if |ratio| > tolerance (and |variance| > floor) the count is "out of tolerance": it still posts (no blocking of the physical truth), but raises a notification to owner, app_admin and the plant's plant_manager, and appears on the day-close page as an open item needing a reason category (moisture, loss, returned load, error, theft suspicion, other). Within tolerance: posts silently with an "in tolerance" mark.
- **Pattern reuse:** the receipt variance (`0106`, 200 bp + notification) is the model; same notification route (decision 145 rule: `notify()` only from doors/triggers).

## 5. Gap 2 — plant_manager and counts
Today `stock.count` excludes plant_manager.
Proposal: new permission `stock.count.propose` for plant_manager (own plant only, RLS by plant): he **enters a count**; the door computes the variance and stores a `stock_count` row (counted qty, theoretical at that instant, variance, tolerance applied, status).
- **In tolerance:** the plant_manager's count posts the `count_adjustment` immediately (reason category mandatory).
- **Out of tolerance:** status `pending_decision`; the adjustment is NOT posted until owner or app_admin decides (accept → posts; reject → recount requested; both with a reason). This is the "right to decide": the plant_manager decides in tolerance, owner/app_admin decide out of tolerance.
- Owner/app_admin keep their direct count right (unchanged). No hard deletes; a wrong posted count is corrected by a reversing `count_adjustment`.
- Money visibility: a count shows quantities only; no prices or valuation for plant_manager. A valuation of the variance (quantity × purchase price) is shown to owner/app_admin only.

## 6. Gap 3 — Reorder request plant_manager → office_purchases
Today: thresholds and `getReorderThresholds` exist; `purchase_plan_item` exists; no request object.
Proposal: table `reorder_request` (plant_id, component_id, requested_qty in base units, needed_by, reason, auto_from_threshold boolean, status `open → seen → ordered → cancelled`, created_by, linked `purchase_plan_item_id` or `purchase_id` nullable, decided_by, decided_at; insert-only events table for status changes).
- Created by the plant_manager of the plant (manual) or by a daily job when level < threshold and no open request exists for (plant, component) (auto, `created_by` = system).
- office_purchases sees open requests (quantities and component, no financial balances), turns one into a purchase order (`ACH-YYYY-nnnnn`) from the existing purchase flow; the link makes the chain visible: request → purchase → receipt → stock.
- plant_manager sees only his plant's requests and their status. He has no access to prices or payments (role decision 4).
- No AI creates or sends a request without human confirmation (CLAUDE.md).

## 7. Gap 4 — Hook for hauler receipts (T12)
Truck 13 brings sand/gravel/components to the stock. Spec here is only the contract T12 must meet:
- A hauler delivery is a **receipt** in the existing sense: it increases stock through `record_receipt()`-style movements (source `receipt`), at the plant that owns the stock, with a quantity in base units (tonnes → kg conversion by component, integer).
- It needs a supplier (the quarry), a receiving plant and a quantity; **two-step rule applies**: hauler/driver or SMS declares (code 3/4 on the hauler column), the plant_manager confirms the received quantity; the 2 % variance rule and notification apply to declared vs confirmed.
- SMS or GPS events for the hauler never write stock by themselves (invariant §3); only the confirmed receipt does.
- T12 adds: `truck.kind = 'hauler'`, haul log, cost per tonne (feeds `SPEC-cost-margin.md` delivered price). Until T12, receipts for sand and gravel are entered the existing way.

## 8. Gap 5 — Import from the plant software (structure only)
Context: the plant's batching software shows recipes per code with doses by component code and two totals; real doses stay in the private folder. No API/export is known yet.
Proposal (design only, build when an export sample exists):
- A neutral **batch actuals** staging table: batch_ref, plant_id, produced_at, recipe_code (industrial), volume_l, per component code the actual quantity (base units), source file hash, imported_by, status. Quarantine and twin-content validation reuse the T11 import layer pattern (staging → validate → typed phrase + fresh TOTP → apply).
- A **mapping table** `plant_software_component_map` (software code → KAYAS component, unit factor) and `plant_software_recipe_map` (software recipe code → KAYAS recette + discharge method). The structure of codes seen: recipes with a code and a name (several POMPE/GOULOTTE variants), components by numeric code (aggregates S/C, S/M, GI, GII, cement, EAU, admixtures), values read as kg per m³ (to confirm with a known-volume report).
- Imported actuals **never decrement live stock**; they feed a comparison report "actual vs recipe by day/component/plant" and the count-variance explanation (§4). Whether a later decision lets actuals replace the recipe for consumption is OPEN.
- No real recipe, dose or export is ever committed; tests use fictitious files.

## 9. Gap 6 — Refused loads and component return
Today `delivery_loss` records litres and reason but explicitly does not give components back (`0063`).
Proposed rule (to confirm with owner and plant managers):
- A load is **fully consumed at BL time** (the concrete exists). A refused or returned load does not automatically restore components, because the concrete cannot be un-mixed.
- Exception only for a load cancelled **before production** (existing `cancel_unproduced_order` / `cancelLoad` reversal).
- For a returned load, the plant_manager records a `load_return` with a disposition: `discarded` (loss, no stock effect, valued at cost for the owner's loss report), `reused` (concrete reused for another order of the same class: the second BL draws **zero** new components for the reused m³, the return links to it), or `partial_reuse` (m³ reused). Reuse needs plant_manager confirmation and a reason; the movement effect is a reversing entry only where components were really recovered (e.g. aggregates washed back), entered as a counted adjustment with category "returned load".
- Money: a refused load's invoicing follows the cancellation-fee policy (open owner question); this spec only fixes the stock side.

## 10. Data model summary (sketch; no SQL)
| Table | Key columns | Notes |
|---|---|---|
| `stock_count_tolerance` | plant?, component?, tolerance_bp, floor_qty, effective_from, set_by, reason | insert-only, versioned |
| `stock_count` | plant, component, counted_qty, theoretical_qty, variance_qty, variance_bp, tolerance_bp, status, category, created_by, decided_by | status in_tolerance_posted / pending_decision / accepted / rejected |
| `reorder_request` (+ events) | plant, component, requested_qty, needed_by, status, auto flag, linked purchase | insert-only events |
| `batch_actual` (+ lines, maps) | see §8 | staging, never touches `stock_movement` |
| `load_return` | delivery, litres, disposition, reused_in_delivery?, reason, by | |

## 11. Roles and RLS expectations
| Role | Counts | Tolerance | Reorder | Actuals/returns |
|---|---|---|---|---|
| owner, app_admin | enter, decide out-of-tolerance, valuation visible | edit | see all | see all, decide |
| plant_manager (own plant) | propose; decide in tolerance; no valuation | read | create, see own | record returns, see own |
| office_purchases | none | none | read all, convert to purchase | none |
| office_sales, accountant, driver, pump | none | none | none | none |
All writes through SECURITY DEFINER doors (actor-first, whole-tuple), RLS FORCE by plant, hash-chained audit on every door. The definer catalogue test is updated.

## 12. Edge cases
Theoretical level negative or zero; count of a component with no movements; two counts the same day (second supersedes via reversing adjustment); count entered while a receipt is in transit; tolerance row changed after a pending count (tolerance snapshot is stored on the count); plant_manager of the other plant; reorder auto-job running twice (unique open request per plant+component); request for a component without supplier; returned load that was never invoiced; reuse linking to an already-cancelled BL; unit conversions rounding (one rounding per line, half away from zero, as `scale_qty`).

## 13. Test plan
Unit: variance and bp arithmetic incl. rounding, zero/negative theoretical, tolerance resolution order. Integration (DB): doors refuse wrong role/plant; out-of-tolerance count does not post until decided; invariant test (`loaded` stage and any ingestion role leave `stock_movement` sum unchanged; no INSERT grant); reorder uniqueness; request status machine; audit rows written; definer catalogue. E2E (fictitious): plant_manager counts in/out of tolerance and owner decides; plant_manager raises request, office_purchases converts it. Negative sweeps assert refusal, not only absence of success (R20-04 lesson).

## 14. Open questions for Ali / owner
1. Tolerance values per component (the 200 bp is an assumption); should cement counted by bags have its own rule?
2. Who counts at each plant and how often (silo, bins, tanks)? Daily, weekly?
3. May the plant_manager decide in tolerance alone, as proposed?
4. Refused load: discarded vs reused default; is the cancellation fee charged?
5. Does the plant software export actual weights (file or API)? Until then §8 stays design only.
6. Auto reorder: send automatically or only suggest?

## 15. Proposed migration / task order
1. M-A `stock_count_tolerance` + `stock_count` + door + permission `stock.count.propose` + tests (incl. invariant test).
2. M-B variance alert (notification + day-close item).
3. M-C `reorder_request` + events + door + daily job + purchasing screen.
4. M-D `load_return` + door.
5. T12 hauler receipts using §7.
6. M-E `batch_actual` staging + maps, when a real export sample is available (private).
Debt rows: none new unless a deferral occurs; record at build time.
