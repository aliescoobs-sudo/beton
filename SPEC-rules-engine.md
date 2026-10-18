# Spec: `rules-engine`

Status: DRAFT · Depends on: `ledger`, `operations`, `clock` · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
The deterministic "brain": from the ledger and operations facts it computes today's cash position, a day-by-day forecast, account colours and alerts with severities, and — for every risk — its causes and a ranked list of resolution options with computed impact. All numbers come from here; the AI only explains them (R27, 🟡 D38). Same input + same `today` ⇒ same output, always.

## 2. Inputs and outputs
- Input snapshot (built by a service, read-only): money movements, instruments + events, payment plan items, orders, deliveries, purchases + receipts, stock movements, trucks + breakdowns, zones, parameters, `today = clock.today()`.
- Pure domain functions: `cashPosition`, `forecastCash`, `accountColour`, `evaluateRules`, `generateOptions`, `applyWhatIf`.
- Persisted results: `alert`, `alert_event`, `forecast_snapshot` (per run, for history and AI reading).

## 3. Calculations

### 3.1 Cash position (R9, ✅ D14)
- `encaisse` (real) = Σ cleared `money_movement` across caisse + banks.
- `total_incl_uncleared` = encaisse + Σ incoming instruments in `received`/`deposited`.
- Also: Σ outgoing instruments `issued` not yet cleared (cheques in circulation).

### 3.2 Forecast (✅ D12, R11, R17)
Horizon `forecast_horizon_days` = 14 (parameter). For each business date d in [today, today + H]:

```
balance(d) = encaisse(today)
           + Σ inflows dated ≤ d  − Σ outflows dated ≤ d     (not yet in encaisse)
```

Each flow line carries a **certainty**: `certain` (cleared — already in opening), `committed` (we owe: outgoing plan items, issued instruments), `probable` (incoming plan items and incoming instruments not cleared — R11).

Flow date rules:
| Flow | Base scenario date | Worst scenario date |
|---|---|---|
| Incoming instrument deposited | deposit date + `clearing_delay_days` working days (parameter; 1 in the simulation, ✅ A17) | same, excluded if `bounced` |
| Incoming instrument received, not deposited | max(written_date, today) + clearing delay | same |
| Incoming plan item not covered | due_date | due_date (still probable) |
| Outgoing instrument issued, post-dated | written_date | **max(issue_date, today)** — liability from issue date, may be presented early (R11, 🟡 D29, ✅ A13) |
| Outgoing plan item not covered | due_date | due_date |
| Bounced incoming | excluded | excluded |

Output per day: base balance, worst balance, inflows/outflows broken down by certainty, list of contributing line ids (for causes).

What-if: `applyWhatIf(snapshot, change[])` re-runs the forecast with virtual changes (move a flow's date, change an amount, add a purchase, split an order) without persisting — used by options and the dashboard.

### 3.3 Account colour (R14, ✅ D10, 🟡 D21)
Per client/supplier, first match wins (independent of alert severities — an overdue échéance makes the account 🔴 even though its `RCV-OVERDUE` alert is 🟠, ✅ A15): ⚪ all documents cancelled → 🔴 any overdue échéance or bounced instrument in window/dispute → 🟡 an échéance due within `alert_lead_days` (2) → 🟢 all documents fully paid → 🔵 on schedule.

## 4. Rules catalogue (each rule = pure function + ≥ 1 positive + ≥ 1 negative test)

Severity legend (R15, 🟡 D22): 🔴 risk · 🟠 urgent · 🟡 important · 🔵 probable.

| Rule id | Trigger | Severity | Subject (dedupe key) | Source |
|---|---|---|---|---|
| `CASH-DEFICIT` | base (normal) balance(d) < `cash_safety_threshold` (0) for some d ≤ H | 🔴 | first deficit date | R17, ✅ A14 |
| `CASH-DEFICIT-WORST` | worst balance(d) < threshold while base ≥ threshold | 🟠 | first deficit date | R11, ✅ A14 |
| `PAY-DUE` | outgoing plan item / issued instrument due in ≤ 2 days | 🟠 | item id | R16, ✅ D11 |
| `RCV-DUE` | incoming plan item due in ≤ 2 days | 🔵 | item id | R16, ✅ D11 |
| `RCV-OVERDUE` | incoming item past due and uncovered | 🟠 (alert); account colour 🔴 per R14 | item id | ✅ A15 |
| `CHQ-BOUNCED` | incoming instrument bounced | 🔴 | instrument id; reminders at window day 20 and 27, escalates on expiry → suggest `disputed` | R25 |
| `STOCK-SHORTAGE` | projected stock of a component on day d < 0 | 🔴 (blocking) | component + date | R5 |
| `STOCK-LOW` | projected stock < `low_stock_threshold` | 🟠 | component + date | R5 |
| `TRUCK-OVERCAPACITY` | required trip minutes > capacity on day d ≤ H | 🔴 (blocking) | date | R23, 🟡 D45 |
| `LAW6921-RECEIVABLE` | client invoice due in ≤ 7 days, or overdue | 🔵 / 🟠 | invoice id | R24, 🟡 D30 |
| `LAW6921-PAYABLE` | supplier invoice due (69-21 deadline) in ≤ 7 days / ≤ 2 days | 🟡 / 🟠 | purchase id | R24 |
| `INVOICE-MONTH-END` | deliveries of current month not invoiced, ≤ 3 days to month end | 🟠 | month | R24 |
| `RECON-GAP` | raised by `reconciliation` (gap > tolerance) | 🔴 | date + kind | R20 |

All thresholds/lead days are parameters (ask first to change defaults).

**Combined conflict ("black day"):** when ≥ 2 of {`CASH-DEFICIT`, `STOCK-SHORTAGE`, `TRUCK-OVERCAPACITY`, `PAY-DUE`, `CHQ-BOUNCED` affecting the deficit} share the same date d, the engine creates one parent alert `DAY-CONFLICT` (🔴, subject = d) that groups them; children stay individually actionable.

## 5. Alert lifecycle (✅ D13, R18)
- `alert`: id, rule_id, subject_key, severity (computed), severity_override, status (`open`/`acknowledged`/`resolved`/`auto_resolved`), first_detected_at (real + sim), target_date, causes jsonb (line ids + computed amounts), options jsonb, parent_id.
- Recomputed after every relevant write and by `morning-recompute`. Same rule + subject ⇒ the same alert is updated (no duplicates); condition gone ⇒ `auto_resolved` (kept).
- **Reclassify** (owner/partner, step-up 2FA): set `severity_override` (e.g. 🔴 → 🟡 "résolu mais surveillé") with mandatory reason → `alert_event` + audit. If the computed severity later *worsens* beyond the state at reclassification (e.g. deficit grows), the override is dropped and the alert re-notifies.
- `first_detected_at` is never changed — it proves "detected N days ahead".

## 6. Option generator (🟡 A16)
For `CASH-DEFICIT` with shortfall S on date d (and for `DAY-CONFLICT`, S = deficit after adding the cheapest stock resolution, see below), candidate options from a fixed catalogue:

| Option kind | Mechanics (what-if) | Counterparties |
|---|---|---|
| `DEPOSIT-EARLY` | deposit incoming post-dated instruments in hand with written_date > d, chosen in order of written date, so they clear by d | each drawer |
| `POSTPONE-PAYABLE` | move an outgoing plan item **not yet backed by an issued instrument** to a later date (default d + 4 working days) | that supplier |
| `REQUEST-ADVANCE` | raise an incoming échéance due ≤ d of an order delivered/delivering ≤ d (e.g. 20% → 50%) | that client |
| `SPLIT-DELIVERY` | move part of an order to d + 1 (affects stock, trucks, and inflows tied to delivery) | that client |
| `EMERGENCY-PURCHASE` | (stock) buy shortage qty from the preferred supplier at last price, paid per its terms | that supplier |

Generation: evaluate each single option and each pair of options (no pair containing a single that already covers S). Impact = forecast re-run → new balance on d and over horizon, coverage % = min(1, Δ / S), new conflicts created (e.g. a postponement that creates a later deficit is shown, and ranked down).

Ranking (deterministic, ties by option id):
1. Options that cover S fully and create no new 🔴, then partial ones.
2. Among full: fewer counterparties affected; then smaller surplus.
3. Among partial: higher coverage.
Top 3 kept on the alert. For `STOCK-SHORTAGE`: `EMERGENCY-PURCHASE` (cash impact computed) and `SPLIT-DELIVERY`; for `TRUCK-OVERCAPACITY`: `SPLIT-DELIVERY`. The `DAY-CONFLICT` cash view uses `EMERGENCY-PURCHASE` as the stock baseline (pessimistic, it costs cash — 🟡).

Options are proposals for a human. "Execute" on an option only opens the prefilled normal form (e.g. deposit batch, échéance reschedule) — never writes by itself.

## 7. Acceptance criteria
- **AC-RE-01** Determinism: same snapshot + same today ⇒ byte-identical outputs (property test over random snapshots).
- **AC-RE-02** Forecast base vs worst: an outgoing post-dated cheque issued D−20 written D5 appears on D5 in base and on today in worst.
- **AC-RE-03** A bounced incoming cheque disappears from both scenarios and raises `CHQ-BOUNCED` with window end = bounce + 30 d, reminders at day 20 and 27.
- **AC-RE-04** `CASH-DEFICIT` fires when base balance on any day ≤ 14 < 0 and not when it is ≥ 0; threshold change to 50 000 MAD changes the result accordingly.
- **AC-RE-05** `PAY-DUE` fires exactly at today ≥ due − 2 days; `RCV-DUE` is 🔵; `RCV-OVERDUE` is 🟠.
- **AC-RE-06** Every rule in §4 has a positive and a negative unit test (CI check enumerates the catalogue against test names).
- **AC-RE-07** Re-running the engine with no change creates no new alert and no notification; resolving the condition auto-resolves the alert while keeping `first_detected_at`.
- **AC-RE-08** Reclassify 🔴 → 🟡 requires reason + step-up, is logged, and is dropped if the shortfall then grows.
- **AC-RE-09** Black-day fixture (SPEC-simulation §4) at D3 10:05: `CASH-DEFICIT` on D5 with base balance −79 536,00 MAD; `DAY-CONFLICT` combined shortfall 123 036,00 MAD; options ranked exactly: 1) `DEPOSIT-EARLY` (135 000,00, full), 2) `POSTPONE-PAYABLE` FRN-05 + `REQUEST-ADVANCE` CLT-17 (118 696,00, 96.5%), 3) `POSTPONE-PAYABLE` FRN-05 alone (85 000,00, 69.1%).
- **AC-RE-10** Options never write data: after generating and viewing options, the audit log has no business-table writes.
- **AC-RE-11** Account colours follow §3.3 precedence on a table-driven test of ≥ 10 cases.
- **AC-RE-12** Engine run on the full simulation dataset completes < 2 s on a dev laptop (60 clients, 14-day horizon).
- **AC-RE-13** A client with one overdue échéance has colour 🔴 while its `RCV-OVERDUE` alert is 🟠; a worst-case-only deficit never produces a 🔴 alert.
- **AC-RE-14** Changing `clearing_delay_days` to 2 shifts deposited-instrument inflows by one more working day; no literal delay appears in domain code.

## 8. Assumptions relied on
✅ D10–D14; 🟡 D21 (colours), 🟡 D22 (severities), 🟡 D29 (early presentation), 🟡 D30 (69-21 alerts), 🟡 D38 (deterministic engine), 🟡 D45 (truck check), ✅ A13, A14, A15, A17 (parameter); 🟡 A16. Default parameters (horizon 14, threshold 0, lead 2 days, 69-21 reminder 7 days, 71.24 reminders day 20/27) are 🟡.
