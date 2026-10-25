# Implementation Plan: `operations` (core first)

Status: **BUILT** (core O1–O8, 2026-10-24/25; notes in docs/checkpoints/CP-OPS-1-3.md) · Task list: [tasks/todo-operations.md](todo-operations.md) · Spec: [SPEC-operations.md](../SPEC-operations.md) (AC-OPS-01…11)

Depends on `master-data` (recettes, trucks, zones, components), `ledger` (orders, the document counter, purchases when they land) and `clock`. Reconciliation with the plant software and the margin are later phases of this module, not part of the core.

## Overview
What physically happens: each truck load leaves the plant for an order and carries a delivery note (BL) without any price; the stock of every component goes down by the recette in force on the day of the load (cement, sand, gravel 8/15 and 15/25, water, admixture, per m³); supplier receipts add stock; stock levels are compared with thresholds. The goal of the core is that **one manual action shows its effect end to end**: an order, its first load, the stock going down, an invoice, a cheque, the cash position.

## Architecture decisions
1. **Quantities, not money.** `delivery`, `stock_movement` and the BL carry no price, total or payment data. Plant, office, partner, owner and support may all read them; margin (owner and support only, DECISIONS 81) is a later, separate read model. Stock *valuation* is money and is not built.
2. **Consumption is deterministic code, stored as facts.** `consumptionForLoad(recetteLines, volumeL)` is a pure function (one rounding per line, half away from zero, same helper as money: a quantity is an integer in the component's base unit). The service stores the resulting movements; they are never recomputed later, so a later recette version cannot change history (AC-OPS-02).
3. **The recette in force on the load date** (`resolveRecette(type, date)`, latest `effective_from ≤ date`) is stored on the delivery (`recette_id`) and every movement points at its delivery. A load with no recette in force is refused, never zero.
4. **Insert-only everywhere.** `delivery`, `stock_movement` have no UPDATE, DELETE or TRUNCATE grant. Cancelling a load writes a cancelling row and reversing stock movements (R12, AC-OPS-04). The signed-BL return is an append-only `delivery_return` row, unique per delivery (the double recording of A11 is a unique violation, AC-OPS-10), not an UPDATE.
5. **Invariants in the database.** Load volume ≤ truck capacity (R3) and a live order (not reversed) by guard trigger; stock movements for a delivery are written in the same transaction as the load; `UNIQUE (source, source_id, component_id)` backs "one movement per component per delivery".
6. **BL numbers** `BL-YYYY-nnnnn` come from the ledger's gapless counter. The plant creates loads (A11), so `next_doc_number` learns one more caller, `plant`, **for the `BL` prefix only** (the function checks the prefix per role). This is the one grant change of the core and is listed in the checkpoint note.
7. **Stock levels are derived**: Σ movements per component (opening, deliveries, receipts, counts, reversals). Thresholds (`low` per component, owner and partner write) give a derived status `ok / low / short`. Persisted alerts belong to `rules-engine`; the core only shows the status and feeds the effects panel (ledger L35).
8. **Role views.** Plant: today's loads, create a load, record a BL return, stock levels and thresholds, no price, total, client phone or payment (AC-OPS-09). Office: reads loads, records BL returns. Owner/support read all. Partner reads all but money.
9. **Plant software reconciliation is an interface first.** ARCO GOLD TWO exports .xls, .pdf, .txt and .dbf (open question 3); the real file format is unknown. The reconciliation module will define a `PlantImportParser` port and ship a *sample* CSV format (batch id, time, concrete type, volume, truck, cement kg…) marked "to confirm with the plant"; nothing in the core depends on it.

## Dependency graph
```
O1 stock domain (pure) ─ O2 delivery + BL number + createLoad ─ O3 stock movements on a load + levels ─ O4 plant screens
O3 ─ L17 invoice (ledger, pulled forward: invoice lines from deliveries) ─ O6 end-to-end flow + effects (ledger L35)
L20 purchase + L21 receipt (ledger, pulled forward) ─ O5 supplier receipts add stock + thresholds
O2 ─ O7 delivery note (BL) data and print view (no prices)
O3 ─ O8 opening stock and the scenario seed
later: margin (R13), truck capacity (R22–R23), reconciliation + plant import, load cancellation screen
```

## Checkpoints
| Phase | Tasks | Checkpoint |
|---|---|---|
| A Deliveries and stock | O1–O4 | CP-OPS-1: AC-OPS-01, 02, 04, 09, 10; a load moves the stock |
| B Receipts and thresholds | O5 (needs L20, L21) | CP-OPS-2: AC-OPS-03 |
| C End to end | O6 (needs L17), O7, O8 | CP-OPS-3: order → load → stock down → invoice → cheque → cash on the seeded scenario |
| later | margin, capacity, import | with `reconciliation` and `rules-engine` |

## AC coverage
| AC | Tasks |
|---|---|
| AC-OPS-01 load > truck capacity rejected | O2 |
| AC-OPS-02 recette consumption (property test) | O1, O3 |
| AC-OPS-03 receipt of 30 t cement = +30 000 000 g | O5 |
| AC-OPS-04 cancelling a load writes reversing movements | O3 |
| AC-OPS-08 90-minute rule warning | O2 |
| AC-OPS-09 plant screens show no price/total/phone/payment | O4 |
| AC-OPS-10 signed-BL return recorded once | O2 |
| AC-OPS-11 delivery note without prices, printed by office and plant | O7 |
| AC-OPS-05/06/07 projection, margin, capacity | later phases |

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| A recette change rewrites past consumption | High | movements stored at the load, recette_id on the delivery, property test |
| Plant sees a price through a join | High | no money column on these tables; `expectNoFields` on service output and HTML |
| Double BL return (office and plant at the same time) | Med | unique row per delivery, concurrent test |
| Plant software format unknown | Med | interface and sample only; no dependency in the core |
| Stock goes negative silently | Med | derived status `short`, effects panel names it; no hard block (the plant must be able to load) |
| `next_doc_number` widened to plant | Med | prefix check inside the function, test that plant cannot number CMD/FA/ACH |

## Open points for the owner
1. Low-stock thresholds per component (assumed values in the pilot; ask the plant).
2. Whether a load beyond the order's volume is refused (core: refused) or only warned.
3. Plant software export format (open question 3).
