# CP-OPS-PLAN-2: operations second wave (no code)

Written 2026-10-25 on the owner's change of priority: operations (stock, sales volumes, quantities out, trucks) before any further money screen. Documents only: [SPEC-operations.md §7](../../SPEC-operations.md), [tasks/plan-operations-2.md](../../tasks/plan-operations-2.md) and the O9–O15 list in [tasks/todo-operations.md](../../tasks/todo-operations.md).

## What the plan covers
Seven tasks in the owner's order: daily dispatch (O9), trip tracking (O10), production and consumption report (O11), days of cover and reorder (O12), fuel per truck (O13), returned or rejected concrete (O14), sales volume analytics (O15). Twelve new acceptance criteria, AC-OPS-12…25.

## Deviations from the brief and decisions to confirm
- **Tracking has six taps, not five.** The brief lists departed, arrived, unloading started, finished, back. The plan adds `loaded` first, which is the existing one-tap load (it creates the BL and the stock movements): this is how a rotation gets its BL, so waiting and delay can be tied to a load.
- **A driver table is new.** There was none. Name only (R26), owner and partner write. Drivers are paired to trucks in code order by the proposal; hand edits are allowed.
- **Return time is a parameter pair:** the way back is the zone's minutes plus `return_extra_min` (10, washing the drum), as the brief asks for "return time (parameters)".
- **Consumption variance from counts.** Actual consumption is theoretical minus the count adjustments in the period; receipts cancel on both sides. A period without a count has no actual figure (shown empty, never zero).
- **Fuel station fills** are priced at the period's average purchase price (no per-fill price). Money parts owner and support only.
- **Rejected concrete stays billed** unless the owner issues a credit note: billing is the ledger's, not touched here.
- **Office does not see the dispatch** (blind to orders); plant, partner, owner and support do.
- **Verification per task:** lint, typecheck, unit and integration tests, production build and the task's own e2e specs before each commit; the whole e2e suite (about 19 min) once at the end of the wave.

## Open points for the owner
1. Parameter values (SPEC §7.1). 2. A fixed driver per truck? 3. Fuel priced at the average: acceptable? 4. Rejected concrete still billed unless credited: confirm. 5. Should office see the dispatch?
