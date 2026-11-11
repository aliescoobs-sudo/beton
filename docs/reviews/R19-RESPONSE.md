# Response to the independent review R19 (target 1a6d990; tree re-checked at 4243a70)

Date: 11 Nov 2026. Review: `docs/reviews/CODEX-REVIEW-R19.md` (unchanged). This file covers **T10f group 1: R19-01 and R19-02**. Migrations 0224 and 0225, decision 219. R19-03 to R19-12 are not addressed here.

Both findings were re-checked against the current tree (T11b had landed). Both still applied. **FIXED** means the code changed and a named test fails without the change and passes with it (each new test file was run once with its migration removed).

| Finding | Status | Fix | Test, and how it fails before |
| --- | --- | --- | --- |
| **R19-01** requester-only definers | **FIXED** (0224) | `ctx.require_admitted_actor(door)` runs first in `view_disclosure`, `my_disclosures`, `consume_document_copy`, `use_document_request`, `my_document_requests`, the notification doors, `set_my_locale`, push-subscription doors, survey doors, `transfer_pickup/receive`, `decide_cancellation`, `record_receipt(_lines)` (the last two were found by the new sweep). The figure and the copy also check the audience. | `tests/r19-01-admitted-actor.int.test.ts`: real approved disclosure and document requests, a real notification and push subscription, production boundary ON; unset, empty, wrong, reserved, demoted and disabled actors get the exact refusal with state unchanged. Before the fix 6 of 7 tests fail (the unset-role call returns the figure and consumes the view). |
| R19-01 (b)(c)(d) enumeration, lint, catalogue | **DONE** | `tests/helpers/definer-classes.ts` classifies every definer the app or auth login can execute; `tests/definer-catalogue.int.test.ts` lints it (helper before first table access, or reviewed with a reason; no stale, double or redundant entry; auth credential doors are auth-only) and sweeps every door with real arguments under nine no-actor requests, asserting SQLSTATE 42501. | Run before the `record_receipt` fix, the sweep reported `record_receipt`, `record_receipt_lines` (23514 existence oracle) and the unlisted predicates. Integration tests run in CI (`integration.yml`), so a new unreviewed definer fails the build. |
| **R19-02** related-row and NULL-plan leaks | **FIXED** (0225) | `ctx.manager_tuple_ok` applied to `emergencies_open` (NULL-plant exception removed), `trip_delivery_exceptions` (and its order aggregates), `trip_stages`, `delivery_note`, `order_chain` (and child sums), `pump_board/waiting/conflicts`; `driver_trips` requires plan and order to agree and a load of the rotation's own order. | `tests/r19-02-reader-tuples.int.test.ts`: real A/B/NULL tuples, a foreign linked load, a load of the order that sits on plant B; own-tuple controls, owner still sees all. All 8 tests fail without 0225. |

## Not done / limits

- Residual named in decision 219: `receipt_states` and `stock_arrived_pending` still admit a no-plant receipt confirmation to a manager; `driver_instructions` returns a joined truck code.
- The sweep falls back to a random id for target kinds with no row in the database (reported in the test output); those doors are covered by their dedicated suites only.
- The actor-first class is verified by position in the source plus the behavioural sweep, not by a full control-flow proof.
- No real-data gate is closed (G2 stays OPEN).
