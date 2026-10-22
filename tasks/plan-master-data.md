# Implementation Plan: `master-data`

Status: **APPROVED** (2026-10-20, Ali; answers below) · Task list: [tasks/todo-master-data.md](todo-master-data.md)

Specs: SPEC-master-data.md, CAPABILITY-MAP.md, SPEC-platform-security §4. Depends on `platform-security` (done, CP6).
Standard verification for every task: `pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm test:integration` when it touches the DB, `pnpm build` when it adds a route). One commit per task.

## Architecture decisions
1. **SQL-first, no Drizzle table schemas** (recommendation, see chat). Each task adds one hand-written migration `db/migrations/00NN_*.sql` (table + FORCE RLS + grants + audit trigger + checks), typed `pg` queries inside `service/`, Zod row parsers at the boundary.
2. **Every master-data table**: `ENABLE`+`FORCE` RLS, audit trigger, entry in `TABLE_ACCESS`, **no DELETE grant** (AC-MD-06; one generic meta-test covers all current and future master-data tables), `status`/archival instead of delete.
3. **Versioned rows** (recette, purchase_price, selling_price) are insert-only: UPDATE and DELETE are not granted; a new version is a new row with a later `effective_from`.
4. **Role-based field hiding at two levels**: RLS/grants decide which rows and tables a role can read; `project(role, entity, row)` decides fields. Plant reads recette lines through a read path that never selects price columns; `expectNoFields` asserts it on the DOM and on the server action response.
5. **No CIN**: no column, no form field, no i18n key; a schema test scans the information schema and the messages for `cin`.
6. **Per-client override** (A27): permission `client_price_override.write` (owner, partner) in the service, plus an RLS `WITH CHECK` and a table `CHECK (client_id IS NULL OR length(trim(reason)) > 0)` in the database. Office/plant are refused by both.
7. **Pure domain first**: `resolveRecette`, `resolveSellingPrice`, `componentCostPerM3`, unit conversion live in `domain/` (no I/O, property-tested); services only load rows and call them. `src/lib/money.ts` / `quantity.ts` do not exist yet, so Task 1 creates them (`Centimes`, `mulDivRound`).
8. **Codes** (`CLT-001`, `FRN-01`, `T1`) come from a per-prefix counter row locked in the same transaction as the insert; immutable once set (trigger rejects UPDATE of `code`).
9. **Phone and address** are encrypted with `FIELD_ENCRYPTION_KEYS` and registered in `ENCRYPTED_COLUMNS` so `crypto:rotate` covers them; ICE is plaintext (a business identifier, searchable for the duplicate guard).
10. **UI**: one shared list + form kit (Task 2), Radix, logical Tailwind properties only, all strings in `messages/{fr,ar}.json` under `masterData.*`, nav entries filtered by permission, 404 for roles without read permission (as in user admin).

11. **Migrations create structure only; fake data comes only from the pilot seed (T15)** (Ali, CP-M1, DECISIONS 79). Reference values that are still assumptions (zones, 🟡 D53) are seeded there too, with fixed ids and `ON CONFLICT DO NOTHING`.

## Dependency graph
```
T1 money/quantity lib ──────────────────────────────┐
T2 zone (pattern slice: table+RLS+UI+meta no-DELETE)─┼─ T3 client ─ T4 client_site ─ T5 supplier
                                                      ├─ T6 component+units ─ T7 concrete_type ─ T8 recette ─ T9 plant recette view
T1,T6 ─ T10 cost calc + purchase_price ─ T11 selling_price list + resolve ─ T12 per-client override
T2 ─ T13 truck + status log ─ T14 availability
T3,T8,T11,T13 ─ T15 pilot seed ─ T16 fr/ar screenshots ─ T17 closure
```

## Checkpoints
| Phase | Tasks | Checkpoint |
|---|---|---|
| 0 Pattern | T1–T2 | CP-M1: pattern reviewed with Ali before copying it ×12 |
| 1 Parties | T3–T5 | CP-M2: AC-MD-01, 05 (client part) |
| 2 Products | T6–T9 | CP-M3: AC-MD-02, AC-MD-07 (recette part) |
| 3 Prices | T10–T12 | CP-M4: AC-MD-03, 04, 07, 10 |
| 4 Trucks | T13–T14 | CP-M5: AC-MD-08 |
| 5 Close | T15–T17 | CP-M6: all AC-MD-01…10, AC-SEC-04/05 for these tables, coverage ≥ 90% domain |

## AC coverage (closed in T17: every AC maps to passing tests)
| AC | Tasks | Passing tests |
|---|---|---|
| AC-MD-01 | T3 | `tests/client.int.test.ts` (creating clients, sealed phone, no CIN), `domain/party.test.ts`, `scripts/no-cin.test.ts`, `e2e/master-client.spec.ts` |
| AC-MD-02 | T8 | `domain/recette.test.ts` (resolveRecette), `tests/recette.int.test.ts` (versions, stored id never changes), meta-test "insert-only table" |
| AC-MD-03 | T11, T12 | `domain/selling-price.test.ts`, `tests/selling-price.int.test.ts`, `tests/client-price-override.int.test.ts` |
| AC-MD-04 | T1, T10 | `src/lib/quantity.test.ts`, `domain/purchase-price.test.ts` (property test), `tests/purchase-price.int.test.ts`, `tests/master-data-visibility.int.test.ts` (seeded B25 cost 776,16 MAD) |
| AC-MD-05 | T3 (data) | `tests/client.int.test.ts` "archives: … not selectable any more, still readable". The order-selection part closes in ledger/orders |
| AC-MD-06 | T2…T15 | `tests/rls/meta.int.test.ts` (no DELETE/TRUNCATE on any master-data table), `tests/zone.int.test.ts`, `tests/client.int.test.ts`, `scripts/no-delete-ui.test.ts` (no delete in UI, actions, services or messages) |
| AC-MD-07 | T9, T10 | `tests/recette.int.test.ts` (plant/office view), `tests/purchase-price.int.test.ts`, `tests/selling-price.int.test.ts`, `tests/master-data-visibility.int.test.ts`, `e2e/master-recette.spec.ts` |
| AC-MD-08 | T13, T14 | `domain/truck-availability.test.ts`, `tests/truck.int.test.ts` (service, D4/D5 unavailable, D6 available) |
| AC-MD-09 | T2…T16 | `e2e/master-screens.spec.ts` (every screen, fr/ar, 375 and 1280 px, screenshots attached), `scripts/i18n-messages.test.ts` (key parity, key usage, logical properties), one e2e spec per screen |
| AC-MD-10 | T12 | `tests/client-price-override.int.test.ts` (service + RLS + CHECK + audit), `domain/selling-price.test.ts`, `e2e/master-price-override.spec.ts` |
| AC-SEC-04 (master data) | T2…T15 | `tests/rls/matrix.int.test.ts` (generated from `TABLE_ACCESS`: every table × every role) and `tests/rls/meta.int.test.ts` (a table missing from the registry fails) |
| AC-SEC-05 (master data) | T9, T10, T17 | `tests/master-data-visibility.int.test.ts`: plant sees no price or cost, office sees no cost or margin |

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Pattern copied 12× with a flaw | High | CP-M1 review after T2 before anything else |
| Plant reads a price through a forgotten join | High | no grant on price tables for plant + `expectNoFields` on every plant-facing view |
| Rounding drift between unit expressions | Med | single `mulDivRound`, property test T1/T10 |
| Arabic labels/RTL regressions per screen | Med | key-parity + screenshot test, logical properties lint |
| Insert-only versioning hides corrections | Low | a correction is a new version with a later date (A12) |

## Decisions (Ali, 2026-10-20)
1. SQL-first for all business tables; Drizzle stays only as the migration runner (DECISIONS 43).
2. Duplicate ICE **blocks** creation (the fix is to add a site to the existing client). Owner and partner may override with a mandatory reason, audited. Similar names stay a warning.
3. Archiving clients and suppliers: owner and partner only in the pilot, audited.
4. Pilot concrete types: B12, B20, B25, B30 (fake data, configurable).

## Open questions
- Should the plant see client names for deliveries later? (decided in ledger/operations; no effect here.)
