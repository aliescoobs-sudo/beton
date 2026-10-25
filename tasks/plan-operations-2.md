# Implementation Plan: `operations`, second wave (dispatch, tracking, consumption, cover, fuel, loss, analytics)

Status: **APPROVED BY THE OWNER'S BRIEF 2026-10-25** (operations before any further money screen) · Spec: [SPEC-operations.md §7](../SPEC-operations.md) (AC-OPS-12…25) · Task list: [tasks/todo-operations.md](todo-operations.md) (O9–O15) · Checkpoint note: docs/checkpoints/CP-OPS-PLAN-2.md

Builds on the operations core (O1–O8: loads, BL, stock movements, receipts, thresholds), the rules engine's stock projection and the master-data trucks, zones and breakdown log. No new module: everything lands in `operations` (dispatch, tracking, report, fuel, loss, analytics) except the reorder draft, which extends `rules-engine`'s existing stock projection and draft purchase.

## Architecture decisions
1. **Plans and facts stay apart.** A dispatch proposal is a pure function and writes nothing. A person saves it (D65); what is saved is an insert-only plan (`trip_plan`, cancelled by `trip_plan_cancellation`). What really happened is another insert-only table (`trip_event`). Delay, waiting time and the other figures are derived from the two, never stored.
2. **One pure rulebook for the plan.** `checkDispatch` validates any plan, the generated one or one edited by hand, so the screen and the service cannot disagree. Two conflicts are also database guards because they are safety rules, not preferences: a truck that is not available that day (breakdown log) and a rotation over the truck's capacity. The SQL availability function mirrors the TypeScript one, with a parity test over random logs.
3. **Times are stored facts.** Planned minutes are stored on the rotation from the parameters in force when it was saved; a later parameter change never rewrites a saved plan (same logic as the recette stored on a load).
4. **Tracking reuses the load.** The first step, `loaded`, is the existing one-tap load: one transaction creates the delivery (BL, stock movements) and the event that links it. `createLoad` gets a transaction-scoped twin, so no second path writes a delivery.
5. **Consumption report is arithmetic over stored facts.** Theoretical consumption is Σ the movements written at each load (recette in force on the load date); nothing is recomputed from today's recette. Actual consumption comes from the count adjustments. Pure domain function, property-tested; tolerance is a parameter.
6. **Quantities and money are different tables.** Everything the plant or partner may read has no money column. Fuel cost needs prices: `fuel_purchase` is a money table (owner writes, owner and support read, support reads audited, audit rows hidden from others); the cost per litre and per m³ are computed by deterministic code from it and returned only to owner and support. The partner's analytics response has no amount field at all (not a null one).
7. **Draft, never an order.** The reorder suggestion is the existing purchase draft of the rules engine: supplier, quantity, date. It inserts nothing in `purchase`.
8. **Fake data.** `db:scenario` is extended (idempotent, `belgobeton_seed` grants SELECT/INSERT only on the new tables, simulation only): drivers, a day plan, tracked rotations with waiting times, consumption with a few count adjustments (one flagged variance), supplier lead times, fuel fills and purchases, two rejected loads.

## Dependency graph
```
parameters + driver + supplier.lead_time ─ O9 dispatch (domain, tables, service, screen)
O9 ─ O10 tracking (events, phone screen, derived figures)
O11 consumption report (reads deliveries and count adjustments; independent of O9/O10)
O11 ─ O14 rejected concrete (adds the loss line to O11)
rules-engine stock projection ─ O12 days of cover and reorder draft
O13 fuel (fills, purchases; reads deliveries for m³ per truck)
O15 sales analytics (reads deliveries and orders)
Built in the order the owner gave: O9, O10, O11, O12, O13, O14, O15, then the scenario, DEMO.md.
```

## Tasks
| Task | What | Main files |
|---|---|---|
| O9 | Daily dispatch: rotations per truck capacity, times from the zone, breakdown-aware, conflicts shown | migration 0058, `operations/domain/dispatch.ts`, `service/dispatch-service.ts`, `/dispatch` |
| O10 | Trip tracking, one tap per step on a phone-sized screen | migration 0059, `domain/trip-times.ts`, `service/trip-service.ts`, `/trips` |
| O11 | Production and consumption report with tolerance flag | `domain/consumption-report.ts`, `service/report-service.ts`, `/reports/consumption` |
| O12 | Days of cover and reorder suggestion with supplier lead time | migration 0060 (`supplier.lead_time_days`), rules-engine stock domain, stock screens |
| O13 | Fuel per truck | migration 0061, `domain/fuel.ts`, `service/fuel-service.ts`, `/fuel` |
| O14 | Returned or rejected concrete | migration 0062, `service/loss-service.ts`, load screens, report line |
| O15 | Sales volume analytics | `domain/volume-analytics.ts`, `service/analytics-service.ts`, `/analytics` |

Every task: unit tests first for the pure part, integration tests (RLS, matrix, `expectNoFields`, concurrency where a rule is a race), fr and ar messages with key-parity, nav entry by permission, an e2e spec and the screen check, one commit. Standard verification before each commit: `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit and integration), `SIMULATION_ENABLED=false pnpm build`, the new e2e spec plus the screen check; the whole e2e suite runs again at the end of the wave, not after each task (it takes about 19 minutes).

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Greedy dispatch gives a plan the plant would not choose | Med | it is a proposal; hand edits are re-checked by the same rules; the plan is only a plan |
| SQL and TypeScript disagree on truck availability | High | parity test on random logs; the database is the last word |
| Variance sign misread (more used vs less used) | Med | the report names it ("plus consommé que prévu"), the AC pins a worked example |
| Fuel station fills priced at an average | Low | stated on the screen; decision for the owner |
| A money figure reaches the partner or the plant | High | separate money tables and response shapes, `expectNoFields` on every response and page, e2e scan for formatted amounts |
| Rejected concrete still billed | Med | not changed here; listed for the owner (credit note is the existing path) |

## Open points for the owner
1. The parameter values of SPEC §7.1 (loading, return extra, day start, working minutes, tolerance, margin days).
2. Drivers paired to trucks in code order: is there a fixed driver per truck in reality?
3. Fuel filled at a station is priced at the period's average purchase price: acceptable, or enter the price per fill?
4. Rejected concrete stays billed unless the owner issues a credit note: confirm.
5. Whether the office should see the dispatch (today it does not: it is blind to orders).
