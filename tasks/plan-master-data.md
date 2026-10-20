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

## AC coverage
| AC | Tasks |
|---|---|
| AC-MD-01 | T3 |
| AC-MD-02 | T8 |
| AC-MD-03 | T11 |
| AC-MD-04 | T1, T10 |
| AC-MD-05 | T3 (data); order-selection part closes in ledger |
| AC-MD-06 | T2 (generic), re-run each task |
| AC-MD-07 | T9, T10 |
| AC-MD-08 | T14 |
| AC-MD-09 | T2…, T16 |
| AC-MD-10 | T12 |

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
