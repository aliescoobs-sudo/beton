# Task list: `master-data`

Plan: [tasks/plan-master-data.md](plan-master-data.md). Standard verification for every task: `pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm test:integration` when it touches the DB, `pnpm build` when it adds a route). One commit per task. Checkpoint review with Ali after T2 (CP-M1) before T3.


### - [ ] T1: Money and quantity primitives (XS/S)
Branded `Centimes`, `mulDivRound` (round half away from zero, one rounding point), `BaseQty`; unit conversion `toBase(qty, factor)`.
**AC:** AC-MD-04 domain part: 2.5 t × 1 450,00 MAD/t → 2 500 000 g, cost 3 625,00 MAD; fast-check: integer result, and ±1 centime across equivalent unit expressions.
**Verify:** `pnpm test src/lib` · **Files:** src/lib/money.ts, src/lib/quantity.ts, tests · **Deps:** none

### - [ ] T2: Zone — the pattern slice (M)
Migration 0017 `zone` (+ shared `code_sequence` table), FORCE RLS, audit, no DELETE; seed the 5 zones (D53); managers edit, all roles read; list + edit page in fr/ar; `TABLE_ACCESS` entries; generic meta-test "no master-data table has a DELETE grant".
**AC:** AC-MD-06 (generic test); AC-MD-09 first screen; AC-SEC-04 for `zone` × 4 roles; office/plant write refused (service + RLS).
**Verify:** `pnpm test:integration rls`, e2e `master-zone.spec.ts` · **Files:** migration, service/zone-service.ts, ui/zones/*, src/app/[locale]/(protected)/master-data/zones/page.tsx, messages · **Deps:** T1 (not needed), CP6

### Checkpoint CP-M1 — Pattern
- [ ] T1–T2 green; pattern reviewed with Ali before it is copied

### - [ ] T3: Client create / edit / archive (M)
Migration `client` (code `CLT-nnn`, kind, ice, phone_enc, contact_name, default_zone_id, payment_terms_days default 60 max 120, notes, status). Create form needs only name + kind. Duplicate guard: a matching ICE **blocks** creation and points to the existing client (add a site instead); owner/partner can override with a mandatory reason, audited (new permission `parties.ice_override`); a similar normalized name only warns. Archive replaces delete and is owner/partner only (new permission `parties.archive`).
**AC:** AC-MD-01 (name + kind only; code generated; ICE optional; schema/UI/messages contain no CIN); AC-MD-05 data part (archived client excluded from the "selectable" query, still readable); office W (create/edit, not archive), plant no access (404); ICE duplicate blocked for office, override with reason by owner/partner audited; archive refused for office; phone not readable in a raw SELECT.
**Verify:** unit (normalization, dup guard) + integration + `e2e/master-client.spec.ts` fr/ar · **Deps:** T2

### - [ ] T4: Client sites (S)
`client_site` (label, address_enc, zone_id) inside the client page. **AC:** office W; address encrypted and registered in `ENCRYPTED_COLUMNS` (rotation test covers it); RLS matrix. **Deps:** T3

### - [ ] T5: Supplier (S)
`supplier` (`FRN-nn`, category enum, ice, phone_enc, terms, status), same pattern as clients. **AC:** office W (not archive); archive owner/partner only, audited; code immutable (trigger test); matrix. **Deps:** T3

### - [ ] T6: Components and purchase units (M)
`component` (name_fr, name_ar, base_unit, low_stock_threshold) and `purchase_unit` (label, factor_to_base int); seed the 6 components. Managers write.
**AC:** factor must be a positive integer (CHECK); both language names required; AC-SEC-04 matrix. **Deps:** T2, T1

### - [ ] T7: Concrete types (S)
`concrete_type` (code `B20`…, label, status). **AC:** managers W, office R, plant R; archived type not selectable; seed B12, B20, B25, B30 (configurable). **Deps:** T2

### - [ ] T8: Recette versions (M)
`recette` + `recette_line` (insert-only), `resolveRecette(type, date)` in domain, "new version" form (copy last version, change quantities, pick `effective_from`).
**AC:** AC-MD-02 (version at D leaves earlier dates on the old version; a stored recette id never changes); no UPDATE/DELETE grant on both tables; managers W; line quantities are integers in base units. **Deps:** T6, T7

### - [ ] T9: Plant recette view (S)
Read path for plant: quantities per m³ with no price column; `project()` entry for `recette`.
**AC:** AC-MD-07 (recette part): `expectNoFields` on the page and on the action response for plant and office; plant cannot read `purchase_price` or `selling_price` (RLS matrix). **Deps:** T8

### - [ ] T10: Purchase prices + component cost per m³ (M)
`purchase_price` (insert-only, versioned, supplier, unit); domain `componentCostPerM3(type, date)` = Σ qty × price / factor via `mulDivRound` (computed, never stored); "propose new version from last purchase" is a stub returning the last price (the purchases themselves come with ledger).
**AC:** AC-MD-04 (full: example and property test through the service); AC-MD-07 office cannot write; plant sees nothing. **Deps:** T1, T6, T8

### - [ ] T11: Selling prices (list) + `resolveSellingPrice` (M)
`selling_price` insert-only with `client_id` nullable; domain `resolveSellingPrice(type, client, date)` returns `Result` (error `NO_PRICE`, never 0); list-price form for managers; office R.
**AC:** AC-MD-03 (override beats list; none → error); versioning by `effective_from`. **Deps:** T7, T3

### - [ ] T12: Per-client price override with reason (S)
Override form (managers only) with required reason; DB CHECK + RLS WITH CHECK + service permission `client_price_override.write`; audited like any price version.
**AC:** AC-MD-10: office and plant refused by service and by direct SQL under RLS; owner/partner without reason refused (service and CHECK); with a reason saved and one audit event with reason in `after`; override shown on the client page. **Deps:** T11, T3

### - [ ] T13: Trucks and status log (M)
`truck` (code `T1`…, plate, capacity_l default 8000) and `truck_status_log` (from, to, reason, logged_by); plant logs breakdown/roadblock, managers edit trucks.
**AC:** plant writes status only (cannot edit plate/capacity: service + column grants); log is insert-only; matrix. **Deps:** T2

### - [ ] T14: Truck availability query (S)
Domain `isTruckAvailable(truck, date, log)`; service `unavailableDates(truckId, range)` for the future capacity check.
**AC:** AC-MD-08 (breakdown for [D4, D6) → unavailable D4, D5, available D6). **Deps:** T13

### - [ ] T15: Pilot master-data seed (S)
Fake-data seed (clients, suppliers, 6 components, B20/B25/B30 recettes, price lists, 4 trucks, zones) behind `SIMULATION_ENABLED`; refuses with `REAL_DATA=true`. Full fixture is completed by `simulation`; this is the minimum so screens are not empty.
**AC:** idempotent; refuses outside simulation; every row audited as `system/seed`. **Deps:** T3–T13

### - [ ] T16: Bilingual screenshot check (S)
Playwright over every master-data screen in fr and ar: no horizontal overflow, `dir="rtl"` on ar, no missing i18n key (key-parity test between `fr.json` and `ar.json`), no CSP violations.
**AC:** AC-MD-09. **Deps:** T15

### - [ ] T17: Closure (S)
Fill the AC table, check `TABLE_ACCESS` covers every new table, AC-SEC-05 master-data part (plant sees no price; office sees no cost fields), coverage ≥ 90% on `master-data/domain`, DECISIONS/README update.
**AC:** all AC-MD-01…10 mapped to a passing test. **Deps:** T16

