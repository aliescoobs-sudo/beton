# T9 design note: one shared status for a rotation (driver and plant)

Status: design, written before the code (owner's task T9, 9 Nov 2026). Migration `0209_trip_shared_status.sql` (forward only; no applied migration is edited).

## 1. What exists today (read before designing)

- `trip_event` (migration 0059) is already the insert-only, audited, `UNIQUE (trip_id, step)` log of a rotation, with a guard trigger
  (live rotation, previous step recorded, not earlier than it) and an advisory lock `trip_event:<trip>`. Six steps: `loaded`, `departed`,
  `arrived`, `unloading_started`, `unloading_finished`, `back`.
- Two writers: the plant (`recordTripStep`, service) and the driver (`driver_report`, a `SECURITY DEFINER` function called by the field sync).
- Two things made the two sides disagree: (a) the driver's first tap, `loading_started`, lives in a side table (`trip_driver_report`) and the plant
  never sees it as a stage; (b) the step `loaded` IS the plant's load (it creates the delivery, the BL and the stock movement), so a driver
  could not tap it and was blocked with "En attente du chargement par la centrale".
- **A coupling the task forbids:** the trigger `trip_event_delivered` (migration 0064) marks the rotation's load as delivered (`delivery_delivered`,
  the input of the invoice queue) when ANY writer records `unloading_finished`. A driver tap would therefore set a delivered quantity.

## 2. Decision: evolve `trip_event` (the existing equivalent); do not add a second table of states

One table, one row per (rotation, stage). State is always derived from it. Nothing is stored twice. Changes (all in 0209):

| Column | Meaning |
|---|---|
| `step` (existing) | now seven values: `loading_started` is added first (`loading_started, loaded, departed, arrived, unloading_started, unloading_finished, back`) |
| `at` (existing) | **occurred_at**: the server's clock instant when the stage was recorded; never taken from the phone |
| `created_by` (existing) | actor user id |
| `actor_role` | the role at the moment of the tap (`driver`, `plant_manager`, `owner`, `app_admin`) |
| `source` | `driver` \| `plant` \| `admin` (derived from the role by the function, never sent by a caller) |
| `client_time` | the phone's time of the tap (offline drivers), nullable; bounded as before (not more than 5 min ahead, 48 h back); only used for delay figures |
| `implicit` | true when the row was filled in because a later stage was recorded first |
| `client_key` | the phone's idempotency key of the tap (replays), nullable; unique per trip |
| `delivery_id` (existing) | the plant's load (BL). Allowed to be NULL on `loaded` (a stage declared by the driver); set once, by the plant, see §4 |

Existing rows are back-filled: `source` from the author's role, `implicit = false`, `actor_role` from the user table.

Corrections are NOT updates: a new insert-only table `trip_event_correction` (trip, step, `corrected_at`, mandatory `reason`, actor, role,
previous effective time), audited like the rest. The effective time of a stage is the latest correction's time, else `at`.
The original row is never touched. A correction cannot break the order (≥ the previous stage's effective time, ≤ the next one's).

## 3. Rules, and where each is enforced

| # | Rule | Enforcement |
|---|---|---|
| 1 | One source of truth | `trip_event`; `trip_stages()` derives both screens' state from it |
| 2 | Forward only, implicit fill, never overwrite | `record_trip_stage()` inserts the missing earlier stages (`implicit = true`, same instant) then the target, in one transaction; `UNIQUE (trip_id, step)`; the guard trigger still requires the previous stage |
| 3 | Idempotent, race-safe | advisory lock `trip_event:<trip>` first (the key the writers already use), then read-or-insert; a second tap returns the existing row (`recorded = false`) with who and when; no read-then-write window |
| 4 | Corrections: plant manager of the plant, owner, app_admin; reason; audited | `correct_trip_stage()`: role check inside the function, reason 3..500 chars, insert into `trip_event_correction` (audit chain attached); the driver has no path to it |
| 5 | Server-side authorization | both functions are `SECURITY DEFINER` with positive checks (`ctx.driver_id()` + own rotation; `plant_manager` + `plant_id = ctx.plant_scope()`; `owner`/`app_admin`); an absent or unknown role is denied (no `NOT IN` on a NULL); a plant-less rotation is refused to a plant manager (as `trip_started`, migration 0208) |
| 6 | Money and stock separation | see §4 |
| 7 | Who and when on both screens | `trip_stages(date)` returns, per stage: step, effective time, source, implicit, corrected, and for `loaded`: whether the plant's load exists |
| 8 | Live refresh | one read endpoint with a strong `ETag` / `If-None-Match` (304), polled every 12 s with a little jitter by both screens; authenticated; same-origin enforced (Origin / Sec-Fetch-Site check as the other routes); read rate limit |
| 9 | Offline | the phone queues the tap with `client_time` and its key; the server records its own instant; a replay returns `replayed`; the screen shows "pending sync" until the answer |
| 10 | Alerts | delay figures (`trip_delay`) and the late-departure rules keep their inputs: they are computed from the stage's `client_time` when present and credible, else its server instant; the stage a plant fills in for a driver counts too |
| 11 | UI | 44×44 targets, fr / ar / ary, RTL; screenshots in `.logs/visual-checks/` |

## 4. Money and stock separation (decision to be written in DECISIONS.md)

1. **A stage is operational tracking only.** `record_trip_stage()` writes `trip_event` (and, for `loading_started`, the legacy
   `trip_driver_report` projection that the timing readers still use). It never writes `delivery`, `stock_movement`, `delivery_delivered`,
   an invoice or a payment row. A test counts those tables before and after every driver tap.
2. **`loaded` declared by the driver** has `delivery_id = NULL`. The screens say "déclaré par le chauffeur" until the plant's load exists.
3. **The plant's load** (`recordTripStep('loaded')`, the BL and the stock) keeps being the plant's own batch record. When the driver already
   declared `loaded`, the plant's load is created exactly as before and then LINKED to that row by `attach_trip_load()`: the only update the
   table ever allows, `delivery_id` from NULL to a value, once, by the plant, trigger-enforced (nothing else of the row can change).
4. **Delivered** (`delivery_delivered`, which feeds invoicing): the trigger `trip_event_delivered` now fires only for stages whose
   `source` is `plant` or `admin`. A driver-declared `unloading_finished` leaves the load undelivered until the plant confirms it with
   `confirm_trip_delivered()` (plant manager of the plant / owner / app_admin; needs the plant's load; idempotent). This changes a behaviour of
   migration 0064 on purpose, because the task forbids a driver tap from setting a delivered quantity.
5. The driver's volume unloaded (`trip_driver_report.unloaded`) stays a declared figure; it is not a delivered quantity.

## 5. Migration plan (forward only)

1. `0209_trip_shared_status.sql`: columns and checks on `trip_event`; back-fill; `trip_event_correction`; trigger changes (guard for seven
   stages and a NULL load; update guard; delivered trigger by source); functions `record_trip_stage`, `correct_trip_stage`,
   `attach_trip_load`, `confirm_trip_delivered`, `trip_stages`; `driver_report` re-created to call `record_trip_stage` (same signature, same
   outcomes `recorded` / `replayed`); `trip_timing` re-created so `loading_started` is read once; grants (`belgobeton_app` only), registry
   entries (`table-access`), journal entry.
2. Existing readers keep working: the six old steps keep their names and meaning; `trip_started` already counts any event.
3. Rollback is a new forward migration; no applied migration is edited.

## 6. Tests (written first)

Unit: state derivation, forward-only, implicit fill, next-stage hint, effective time with corrections. DB / RLS: driver on another's trip,
cross-plant plant manager, plant-less rotation, NULL / unknown role, `partner` / `support` / `office` denied, direct insert / update / delete on
`trip_event` denied. Concurrency: parallel taps on one stage (one row, both callers told who/when); parallel taps on different stages (order
holds). Audit: actor, role, source recorded; corrections with reason in the hash-chained log; verification of the chain. Invariance: a driver
tap changes no stock movement, delivery, delivered row, invoice or payment (row counts and sums). E2E: plant records `loaded` and the driver's
screen shows it; the driver records `departed` and the plant screen shows loaded (implicit) + departed; correction flow.

## 7. Known limits (stated now)

- A stage tapped by mistake cannot be erased (no hard delete): a correction re-times it. A "void" correction is not in this task.
- A driver who skips `loaded` produces an implicit `loaded` without a load; the plant still has to make its own batch record.
- The first polling interval is 12 s: a stage can take up to about 12 s to show on the other side; the writer's own screen updates at once.

## 8. T9b (migration 0210): two marks, stage authority, exceptions

- **Two marks.** The driver's `unloading_finished` is the operational "delivered" (the stage row, shown as "déclaré par le chauffeur"). The billing gate `delivery_delivered` is set only by the
  plant side: its own explicit `unloading_finished`, the plant confirming the RETURN (`trip_event_return_gate` / `trip_confirmation_return_gate` call `_gate_on_return`: same
  transaction, the plant user as actor, `via = 'return'`, once), or `confirm_trip_delivered()` (`via = 'confirm'`). §4.4 above (a driver's unloading delivers nothing) is unchanged.
- **Authority per stage** (`STAGE_AUTHORITY`): either side for `loading_started`, `loaded`; the plant for `departed`, `back` (a driver's tap is "awaiting the plant"; `confirm_trip_stage()` writes
  `trip_event_confirmation`, whose instant is the one the timing figures use); the driver for `arrived`, `unloading_started`, `unloading_finished` (a plant-side record is a flagged fallback).
- **Exceptions** (`trip_delivery_exceptions(from, to)`, scoped like `trip_stages`): `declared_no_record`, `unconfirmed` (end of the working day + `delivery_confirm_delay_min`), `volume_differs`, `order_differs`.
- **Contacts:** `company_contact_phone()` for the driver's `tel:` link.
- **What is recomputed:** see DECISIONS 206 (9).
