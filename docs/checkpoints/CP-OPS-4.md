# CP-OPS-4: operations second wave (dispatch, tracking, consumption, cover, fuel, refused concrete, sales volumes)

Built 2026-10-25 on the owner's change of priority, in the order he gave. Plan: [tasks/plan-operations-2.md](../../tasks/plan-operations-2.md), spec: [SPEC-operations.md §7](../../SPEC-operations.md), earlier note: [CP-OPS-PLAN-2](CP-OPS-PLAN-2.md). Reviewed by: nobody yet. Every task below was committed after lint, prettier, typecheck, the unit and integration suites (2 757 tests at the end), the production build and the e2e specs of its screens.

## Built
| Task | Commit | What | AC |
|---|---|---|---|
| O9 | ff5b6e1 | daily dispatch: rotations by truck capacity, truck, driver, times from the zone and the parameters; a truck in the breakdown log cannot be planned (service and database, with a parity test of the SQL availability against the TypeScript one); conflicts shown; a person saves; replanning cancels with a reason; drivers (migration 0058) | AC-OPS-12 to 15 |
| O10 | ae293b8 | trip tracking on a phone-sized screen, one tap per step; the first step is the load itself (one transaction); steps in order, once, with the clock's instant; waiting time, unloading, round trip, concrete age, departure delay derived; started rotations stay when the day is replanned (0059) | AC-OPS-16, 17 |
| O11 | 34c5e37 | production and consumption report: m³ per type and period, theoretical consumption against the count adjustments, variance in basis points flagged above `consumption_tolerance_bp` (0060) | AC-OPS-18, 19 |
| O12 | 0a5f05f | days of cover and reorder suggestion with the supplier's lead time (new field, parameter fallback) and a safety margin; a draft purchase for the owner (0061) | AC-OPS-20, 21 |
| O13 | c19bc51 | fuel per truck: fills with the odometer (never backwards), purchases as a money table, price per litre, cost per truck and per m³ for owner and support only (0062) | AC-OPS-22 |
| O14 | b36f7f4 | refused or brought-back concrete per load with a reason, once, counted as loss lines of the report (0063) | AC-OPS-23 |
| O15 | 75069d9 | sales volumes per day, week, month by client, type, zone; amounts for owner and support only | AC-OPS-24 |
| scenario | (this commit) | `db:scenario` seeds drivers, 84 tracked rotations, plans ahead, 24 counts, fuel, refused loads, supplier lead times, one big gravel gap so that the cover screen has a reorder; idempotent, audited as system | AC-OPS-25 (screen checks fr and ar for every new screen) |

AC-OPS-25 (every screen in fr and ar, 375 and 1280 px, Latin codes isolated, no CSP violation): `e2e/{dispatch,trips,consumption-report,reorder,fuel,loss,analytics}.spec.ts` and `e2e/ledger-screens.spec.ts`.

## Exposure of money in the new screens
- Quantities and money are different tables: `fuel_purchase` is the only new money table (owner writes, owner and support read, audit rows hidden from the others, in the money-visibility test).
- The answers of the services for the others have **no money key at all**, not a null one: the fuel report (`money`), the analytics (`amounts`), the reorder view (no supplier, no price, no draft). `expectNoFields` on every response, and e2e scans for formatted amounts in the HTML of plant and partner pages.
- No new SECURITY DEFINER function is executable by the application role (`truck_available_on` is used only by a guard); the reviewed-function list in `tests/ledger-exposure.int.test.ts` did not change for this wave.

## Deviations and things to decide
- **Six tracking steps, not five** (`loaded` first) so a rotation carries its BL.
- **A driver table is new**, paired to trucks in code order by the proposal.
- **Overdue orders** (due in the last two weeks, still to load) are planned with the day's from the business day on: not in the brief, needed for the plant to plan what it really has to load.
- **A count counts in the period it is entered**, and measures everything since the previous count (the books carry no counted level, only the adjustment).
- **Cover is in calendar days** until the stock reaches zero; supplier lead time is in calendar days; `purchase_lead_days` (working days) is the fallback.
- **Plant and partner get the parameter lead time**, not the supplier's: the supplier of a component is read from purchase lines, which are money.
- **Times on the tracking screen are formatted on the server** in Casablanca time: the browser's time-zone data differed from Node's here (a hydration mismatch), so the browser never formats an instant.
- **Rejected concrete stays billed** unless the owner issues a credit note; the BL return still carries its own `returned_volume_l` (a signed-BL detail), the loss table is the one the report counts.
- Fuel filled at a station is valued at the average price of the fuel bought.
- Decisions 91 to 96 in docs/DECISIONS.md record all of this as provisional.

## Fixes made on the way (found by the full e2e run)
The forecast chart widened the page (its day cells' hidden text escaped the scroll box; the inline styles it used were blocked by the CSP anyway), the partial-receipt screen stayed on its "done" panel after the first partial receipt, Latin codes of the dashboard were not isolated in Arabic, and two dashboard e2e assertions assumed the first alerts of the list were their own.

## Open points for the owner
The parameter values of SPEC §7.1; a fixed driver per truck; fuel priced at the average; rejected concrete credited or billed; whether office should see the dispatch; the real zone minutes and truck capacities (open question 6).
