# Task list: `operations` (core first)

Plan: [tasks/plan-operations.md](plan-operations.md) (proposed). Standard verification for every task: `pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm test:integration` when it touches the DB, `SIMULATION_ENABLED=false pnpm build` and `pnpm exec playwright test` when it adds a route or screen). One commit per task. Every new table: `TABLE_ACCESS` entry (+ `insertOnly`, `noDelete`), matrix fixture, FORCE RLS, audit trigger, no UPDATE/DELETE grant. Migrations create structure only. Checkpoint notes go to docs/checkpoints/CP-<name>.md.

## Phase A: Deliveries and stock

### - [x] O1: Stock domain (pure) (S)
`consumptionForLoad(recetteLines, volumeL)` (one rounding per line, integer base units, half away from zero), `stockLevel(movements)`, `stockStatus(level, lowThreshold)` (`ok/low/short`), `remainingVolume(orderVolumeL, loadedL[])`.
**AC:** AC-OPS-02 (8 m³ B25, cement 350 kg/m³ → −2 800 000 g; property: Σ consumption over loads = recette × Σ m³ within ±1 base unit per load); fast-check.
**Verify:** `pnpm test src/modules/operations` · **Files:** operations/domain/{consumption,stock}.ts + tests · **Deps:** none

### - [x] O2: Delivery, BL number, createLoad (M)
Migration `delivery` (id, bl_no `BL-YYYY-nnnnn`, order_id, truck_id, volume_l, loaded_at, recette_id, reverses_id, created_by; insert-only) and `delivery_return` (unique per delivery: date, returned_volume_l, by); guard: volume ≤ truck capacity, order live, volume ≤ remaining; `next_doc_number` accepts `plant` for `BL` only. `createLoad` (plant, owner, partner), default volume = min(remaining, capacity), 90-minute warning from the zone (R4), `recordBlReturn` (plant or office, once).
**AC:** AC-OPS-01, AC-OPS-08, AC-OPS-10 (two concurrent returns → exactly one), plant cannot number CMD/FA/ACH, AC-SEC-04 for both tables.
**Verify:** `pnpm test:integration delivery rls` · **Files:** migration, operations/service/delivery-service.ts, table-access, matrix, tests · **Deps:** O1, ledger L3

### - [x] O3: Stock movements on a load, levels, opening stock (M)
Migration `stock_movement` (id, component_id, movement_date, qty_base signed, source `delivery|receipt|count_adjustment|opening|reversal`, source_id, reverses_id; insert-only; unique per source and component). `createLoad` writes one movement per recette line in the same transaction from the recette in force on the load date; `cancelLoad` writes the cancelling row and reversing movements; `getStockLevels()`; owner enters opening stock once per component with a date.
**AC:** AC-OPS-02 end to end, AC-OPS-04, a load without a recette in force is refused, rollback leaves no movement, AC-SEC-04.
**Verify:** `pnpm test:integration stock-movement rls` · **Files:** migration, service, tests · **Deps:** O2

### - [x] O4: Plant screens (M)
"Chargements du jour" (orders due today: type, m³ remaining, site/zone, no price; one tap to create a load with truck and m³; BL return), delivery list, stock levels with thresholds. fr/ar, nav entries by permission.
**AC:** AC-OPS-09 (DOM and API: no price, total, client phone or payment for plant); RTL check.
**Verify:** `pnpm exec playwright test e2e/operations-loads.spec.ts` · **Files:** pages, operations/ui/*, messages, e2e · **Deps:** O3

## Phase B: Receipts and thresholds

### - [x] O5: Supplier receipts add stock, thresholds (M)
After ledger L20 (purchase) and L21 (receipt): `recordReceipt` writes `+qty × factor_to_base` per line; `stock_threshold` (owner, partner write) and the derived status on the stock screen.
**AC:** AC-OPS-03 (30 t cement = +30 000 000 g), a receipt cannot be recorded twice, plant sees quantities only.
**Verify:** `pnpm test:integration receipt-stock` · **Deps:** O3, ledger L20, L21

## Phase C: End to end

### - [x] O6: One action, its effect end to end (M)
With ledger L17 (invoice lines from deliveries) and L35 (effects panel): order → load → stock down → invoice → cheque → cash, on the seeded scenario; each step shows what it changed, filtered by role.
**AC:** e2e `flow.spec.ts` walks the six steps as owner; the same steps as office show no money effect.
**Verify:** `pnpm exec playwright test e2e/flow.spec.ts` · **Deps:** O3, O4, ledger L17, L35

### - [x] O7: Delivery note (BL) data and print view (S)
`getDeliveryNote(deliveryId)`: BL number, date, our legal mentions (ledger L29, or placeholders until then), client code and name, site, concrete type, volume, truck, loaded time, signature boxes; no price, total or payment data; printable page for owner, partner, office, plant, support, audited print; PDF through the ledger document kit (L30) later.
**AC:** AC-OPS-11 (`expectNoFields` on data and HTML).
**Verify:** `pnpm test:integration delivery-note` + e2e · **Deps:** O2

### - [x] O8: Opening stock and operations in the pilot scenario (S)
Opening stock per component and three months of loads and receipts in the scenario seed (ledger L34), stock levels near their thresholds for two components.
**AC:** idempotent; every row audited as `system/seed`; the stock screen shows low and short statuses.
**Verify:** `pnpm test:integration pilot-scenario` · **Deps:** O3, ledger L34

### Checkpoint CP-OPS-1 (after O4): deliveries move the stock
- [x] (docs/checkpoints/CP-OPS-1-3.md) AC-OPS-01, 02, 04, 08, 09, 10 green; the plant screens render in both locales

### Checkpoint CP-OPS-2 (after O5): receipts
- [x] (docs/checkpoints/CP-OPS-1-3.md) AC-OPS-03 green

### Checkpoint CP-OPS-3 (after O8): end to end
- [x] (docs/checkpoints/CP-OPS-1-3.md) the six-step flow runs on the seeded scenario; office sees no money effect

## Later (not in the core)
Margin per delivery (R13, owner and support), truck capacity check (R22–R23), projected stock (AC-OPS-05), plant import and reconciliation (ARCO GOLD TWO), load cancellation screen.
