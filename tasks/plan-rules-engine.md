# Implementation Plan: `rules-engine` + `owner-dashboard` ("Aujourd'hui")

Status: **PROPOSED, being built 2026-10-25** · Task list: [tasks/todo-rules-engine.md](todo-rules-engine.md) · Specs: [SPEC-rules-engine.md](../SPEC-rules-engine.md), [SPEC-owner-dashboard.md](../SPEC-owner-dashboard.md) · Money rules: DECISIONS 81, 82

Depends on `ledger` (instruments, plan items, allocations, deadlines, `cashPosition`), `operations` (deliveries, stock, receipts), `master-data` (recettes, components) and `clock`. Replaces the interim home built from the existing services.

## Overview
A deterministic brain: from the facts it computes the cash position, a day-by-day forecast over the next working days, the lowest day and the "black day", alerts with severities, ranked resolution options with computed coverage, and the stock risk per component. The dashboard only formats those numbers. Nothing here is written by the AI, nothing is applied without the owner's confirmation with step-up, and applying leaves an audit trail.

## What is built and what is not (against the specs)
| Spec item | This build |
|---|---|
| Cash position, forecast base + worst, clearing delay parameter | yes |
| Rules catalogue: CASH-DEFICIT, CASH-DEFICIT-WORST, PAY-DUE, RCV-DUE, RCV-OVERDUE, CHQ-BOUNCED, STOCK-SHORTAGE, STOCK-LOW, LAW6921-RECEIVABLE, LAW6921-PAYABLE, INVOICE-MONTH-END, DAY-CONFLICT | yes |
| TRUCK-OVERCAPACITY, RECON-GAP | **no** (truck capacity is a later operations phase; reconciliation does not exist). DAY-CONFLICT groups the others. |
| Options: DEPOSIT-EARLY, DISCOUNT, POSTPONE-PAYABLE, REQUEST-ADVANCE, SPLIT-DELIVERY, EMERGENCY-PURCHASE, COLLECT-OVERDUE (informational, not counted) | yes |
| `alert`, `alert_event` persistence, reclassify with step-up | yes |
| `forecast_snapshot` | **no** (needed by the AI layer for history; later) |
| Nightly `morning-recompute` job wiring | **no**: the system role has no read path to money tables and I will not widen it without the owner's decision. The alert state is refreshed when the owner opens the dashboard or applies an action. |
| Notifications, Telegram, AI brief | no (modules not built); the brief is template text from the same facts |
| Screens | "Aujourd'hui" (home), alert report with options, accounts/échéances stay the existing screens (linked) |

## Architecture decisions
1. **Pure domain, snapshot in, result out.** `modules/rules-engine/domain/*`: `working-days`, `flows` (normalise facts into dated cash flows with a certainty), `forecast` (base and worst per working day), `black-day` (lowest day, severity, causes), `rules` (alert catalogue, each rule a pure function), `alert-state` (fold of events, reclassification), `what-if` (virtual changes), `options` (generator, coverage, ranking), `stock-risk` (day-by-day projection from the recette in force). No I/O, no `Date.now()`, all money integer centimes via `lib/money`. Coverage ≥ 90 % branch gate like the other domains.
2. **Services read, never decide.** `service/snapshot.ts` reads the facts inside `inRequest` as the signed-in user (RLS applies): money facts need `cash.read` (owner, support); the stock-risk snapshot reads only the non-money views (`sales_order_ops`, `purchase_line_ops`, recettes, movements), so partner and plant can have it. One `runEngine(snapshot, today)` returns forecast, alerts, options, stock risk.
3. **Persistence is small and append-only.**
   - `alert` (identity: rule_id + subject_key unique, `first_detected_on`, `first_detected_at`; insert-only) and `alert_event` (detected / resolved / reopened / severity_changed / reclassified; insert-only). The current state is a fold of events plus the freshly computed condition, never a mutable status. `first_detected_*` is never changed.
   - `cash_decision`: the owner's confirmed option (kind, target date, parameters, computed coverage, draft message, the step-up time), insert-only, audited.
   - All three: money tables (owner + support read, owner writes, RLS forced, audit attached, flagged in `table-access` and the RLS matrix, audit rows hidden from the others via `audit.is_money_table`).
4. **What "apply" does.** After a fresh second factor (new sensitive action `cash.apply_option`) the option is written as a `cash_decision` with its computed numbers and draft text, in one audited transaction.
   - `DEPOSIT-EARLY`: also performs the real deposit through the existing `depositInstruments` service (same transaction), the only option that moves money state by itself. The post-dated cheque presented early is flagged by the ledger.
   - `DISCOUNT`, `POSTPONE-PAYABLE`, `REQUEST-ADVANCE`, `SPLIT-DELIVERY`, `COLLECT-OVERDUE`, `EMERGENCY-PURCHASE`: a decision plus a **draft message** (supplier, client or bank) that the owner copies and sends himself. The application sends nothing. Plan items and orders are insert-only and have no reschedule service, so these do not change the forecast: the forecast counts a flow only when it really happens (a collected, postponed or advanced amount appears when the ledger records it). The decision shows on the alert as "décidé le …".
5. **Overdue receivables are not in the forecast** (a late client is not a promise); they are the `COLLECT-OVERDUE` option and the `RCV-OVERDUE` alert, "not counted until paid". Overdue payables count on today (we owe them). This differs from the draft SPEC §3.2 wording ("due_date"), which would count a long-overdue cheque as arriving today.
6. **Parameters** (added to `PARAMETERS`, all configurable, defaults are 🟡): `forecast_horizon_days` 14 (working days; the screen offers 7 or 14), `cash_safety_threshold_centimes` 0, `alert_lead_days` 2, `holidays` (comma-separated dates, default none), `low_stock_lead_days` 7, `purchase_lead_days` 2 (expected receipt of an unreceived purchase), `discount_rate_bp` 800 (annual, for LCN discount), `postpone_working_days` 4, `advance_extra_bp` 3000, `legal_reminder_days` 7, `bounce_reminder_days` 20 and 27. No literal rate or delay in domain code (lint-style test like the ledger's).
7. **Instrument rules.** Cheque and LCN follow SPEC §3.2. Cash and transfers count on `max(date, today)` without delay. An LCN cannot be presented before its date: it is *discounted* (`DISCOUNT`, fee = amount × rate × days / 365, one rounding), whereas a post-dated cheque may be *deposited early* (D29, flagged). Both are 🟡 and listed in the checkpoint.
8. **Roles.** Money forecast, alerts, options and their pages: owner and support (support reads, never applies, DECISIONS 81; each view audited via `recordMoneyView`). Partner and plant: non-money "today" (loads waiting, stock projection and stock alerts, `alerts.stock.read`). Office: loads only (it has no stock read). Their pages do not call the money services; an e2e scan checks no amount appears.
9. **Home page** keeps the entry shortcuts and the re-enrolment banner; the interim tiles are replaced for the owner and support, and trimmed to non-money for the others.
10. **Chart** is hand-written inline SVG (no new dependency): cash above the zero line, deficit below it, the safety threshold line, the worst-case line dashed, the deficit days shaded, a day strip under it with the events listed per day (the day of the week and the flows sorted by amount). Colour is always paired with a label and an icon; RTL by logical layout (the time axis stays left-to-right as numbers do).
11. **Black-day fixture.** SPEC-simulation does not exist yet. A deterministic fixture in `rules-engine/domain` reproduces the shape of AC-RE-09 (full early deposit, partial pair, partial single) with its own numbers; `db:scenario` is extended so the dev database shows a real deficit in the horizon.

## Dependency graph
```
R1 working days + flows + forecast ─ R2 black day, causes, rules ─ R3 alert state (fold, reclassify)
R1 ─ R4 what-if + options ─ R5 stock risk (independent of R1..R4, needs only operations facts)
R3, R4, R5 ─ R6 migration (alert, alert_event, cash_decision) + parameters + step-up action + table-access
R6 ─ R7 services (snapshot, run, sync alerts, reclassify, apply option) ─ R8 dashboard UI + chart + report + roles
R8 ─ R9 scenario so the demo shows a black day ─ R10 e2e, coverage gate, DEMO.md, checkpoint
```

## Checkpoints
| Phase | Tasks | Gate |
|---|---|---|
| A Domain | R1–R5 | unit + property tests green, domain coverage ≥ 90 %, determinism property |
| B Persistence and services | R6–R7 | integration tests (RLS per role, audit, step-up, no write without confirmation) |
| C Screens | R8–R10 | e2e (owner, support, office, plant), axe-free semantics by hand, DEMO.md |

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| A figure on screen differs from the engine | High | the page renders engine values only; an e2e compares DOM with the service output |
| Money leaks to partner, office or plant via the new services | High | separate snapshot for stock (non-money views only), `require` before any read, e2e scan of their pages |
| An option writes without the owner's confirmation | High | one `applyOption` entry point behind `withStepUp`; test that generating and viewing options writes nothing |
| Double counting (an instrument and the plan item it covers) | Med | flows are built from *uncovered* plan item remainders; property test: covering an item by an instrument never changes the total |
| A forecast that looks wrong on real data | Med | forecast rows list contributing flows; scenario run is inspected before the demo |
| Time zone / weekend arithmetic | Med | working-day helper is pure, Mon–Sat, holidays parameter, tested around weekends and month ends |

## Open points for the owner
1. Defaults marked 🟡 above (discount rate, postpone days, advance %, purchase lead days).
2. Wire the nightly recompute: needs the system role to read money tables (a security change I did not make).
3. Should postponements and advances, once agreed, be recordable so the forecast moves (needs a reschedule service on insert-only plan items)?
