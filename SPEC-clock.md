# Spec: `clock`

Status: DRAFT · Depends on: — · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
One source of "now" for the whole system so the pilot can replay a simulated week (🟡 D44) and every rule, job and alert behaves exactly as it would in real time. In production the clock is the real clock and the simulation features don't exist.

## 2. Scope
In: `clock.now()` / `clock.today()`, simulated mode, advancing time, a job scheduler driven by the clock (daily jobs, scripted events), sim-time stamping of audit events.
Out: per-user clocks, rewinding time (reset = re-seed, see `simulation`).

## 3. Data model

| Table | Key columns | Notes |
|---|---|---|
| `sim_clock` | id (singleton), mode (`real`/`simulated`), sim_now timestamptz, updated_by, updated_at | Exists only when `SIMULATION_ENABLED=true` |
| `scheduled_job_run` | job_key, business_date, ran_at (real), sim_at, status, error | Uniqueness on (job_key, business_date) → idempotent |

Daily job catalogue (times are Africa/Casablanca business time, 🟡 A3):

| Job | Time | Effect |
|---|---|---|
| `morning-recompute` | 06:30 | recompute statuses, forecast, alerts for the new day |
| `daily-brief` | 07:00 | build brief facts (+ AI narrative if enabled) |
| `due-reminders` | 07:05 | échéance / 69-21 / 71.24 reminders |
| `day-close` | 20:00 | open reconciliation for the day; flag missing plant import / count |

Event-driven recompute (after any ledger/operations write) runs in addition; the jobs guarantee time-based rules fire even with no writes.

## 4. Behaviour
- `clock.now()` returns real time when mode = `real` or simulation is disabled; otherwise `sim_now`.
- `clock.advance({ to | byDays })` (owner only, step-up 2FA, audited — the role and step-up checks live in the route/server action in `src/app`, the audit comes from the DB trigger on `sim_clock`; `clock` imports no other module) moves `sim_now` forward **step by step**: for each crossed job time and scripted event (from `simulation`), in chronological order, set `sim_now` to that instant and run it to completion before continuing. Advancing 3 days gives the same state as advancing 1 day three times.
- Time never moves backwards; going back = `sim:reset`.
- Guards: simulated mode cannot be enabled when `NODE_ENV=production` or `REAL_DATA=true`; the app refuses to boot in that combination. The UI shows a permanent sim-date badge ("SIMULATION — jeu. 26 nov. 2026 07:00") whenever mode = simulated.
- Audit events record both `at` (real) and `sim_at`.
- `Date.now()` / `new Date()` banned elsewhere by lint rule (`no-restricted-globals` / syntax rule), with `clock` as the only allowed file.

## 5. Acceptance criteria
- **AC-CLK-01** With simulation disabled, `clock.now()` tracks real time and `advance` is not exposed (route 404, service throws).
- **AC-CLK-02** App refuses to boot with `SIMULATION_ENABLED=true` and (`NODE_ENV=production` or `REAL_DATA=true`).
- **AC-CLK-03** Advancing from D1 07:00 to D4 07:00 runs each daily job exactly once per crossed day in chronological order; running `advance` again over an already-run instant runs nothing (idempotent).
- **AC-CLK-04** Advance by 3 days ≡ 3 × advance by 1 day: identical alerts, forecast and audit event sequence (excluding real timestamps).
- **AC-CLK-05** Attempt to set `sim_now` earlier than current fails.
- **AC-CLK-06** Advance requires owner role + TOTP ≤ 10 min; each advance writes an audit event with from/to.
- **AC-CLK-07** Lint fails on `Date.now()` outside `src/modules/clock`.

## 6. Assumptions relied on
🟡 D44 (simulation clock), 🟡 A3 (time zone), 🟡 A5 (working days), job times above (🟡, configurable parameters).
