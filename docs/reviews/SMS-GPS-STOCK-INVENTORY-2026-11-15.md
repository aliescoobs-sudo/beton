# SMS / GPS / STOCK inventory — read-only, 15 Nov 2026

Scope: code at `main` after c199b84 (migrations up to 0228). Read-only: no code, no migration written. Evidence is `file:line`; paths under `db/migrations/` are shortened to the file name. Where a later migration replaces an earlier definition, the latest one is cited. "Not found" means a search of `db/migrations`, `src`, `scripts` returned nothing. Fictitious data only; nothing under `.env*`, `backups/` or accounts files was opened.

## 1. Trip / stage / event model

| Item | Fact | Evidence |
|---|---|---|
| Rotation | `trip_plan`: order, truck, driver, volume_l, five planned minutes (load/depart/arrive/unload_end/back), insert-only | 0058_dispatch.sql:55 |
| Stage log | `trip_event`: one row per (trip, step), insert-only. Steps: `loading_started, loaded, departed, arrived, unloading_started, unloading_finished, back` | 0209_trip_shared_status.sql:10-25 |
| Who/how | columns `actor_role`, `source` (`driver`/`plant`/`admin` only), `client_time`, `implicit`, `client_key` (replay key, unique per trip) | 0209_trip_shared_status.sql:10-29 |
| Corrections | `trip_event_correction`, new rows, stage row never touched | 0209_trip_shared_status.sql:32 |
| Single writer | `record_trip_stage()` SECURITY DEFINER: actor from `ctx`, trip advisory lock, idempotent by key or by stage, a later stage fills skipped ones as `implicit` rows, server instant authoritative, phone time kept apart (credible window +5 min / -48 h) | 0209_trip_shared_status.sql:159-255 |
| Callers | Driver phone: `driver_report()` via `syncActions` (`field-service.ts:282-300`). Plant: `trip-service.ts:211-271` (calls `record_trip_stage`; creates the load via `createLoadInTx` at :260) | field-service.ts:297, trip-service.ts:260,271 |
| Allowed actor roles | driver (own trip only), `plant_manager` (own plant), `plant`, `owner`, `app_admin`. No service/system actor | 0209_trip_shared_status.sql:195-212 |
| Delay | `trip_delay` written by `_record_trip_delay` (called from `record_trip_stage` for every explicit stage except `loaded`); reasons allowed: `traffic, site_wait, breakdown, other` | 0118_trip_timing.sql:14,115; 0209_trip_shared_status.sql:240-243 |
| Emergency | `trip_emergency` via `driver_emergency()`; options depend on the stage (`EMERGENCY_OPTIONS`); `notify_emergency` trigger alerts | 0084_field_app.sql:71,219; 0089_notifications.sql:138-149; steps.ts:46-54 |
| Estimates (D179) | `trip_stage_estimate(plant, zone, stage)` returns minutes + source; override table `trip_estimate_override` set by `set_trip_estimate`; `trip_timing(date)` returns plan vs actual. Basis per brief: median of last 10 rotations, minimum 5 | 0118_trip_timing.sql:43,198,230,276; LEAD-HANDOFF.md:47 |
| Reassign / postpone | `trip_dispatch_change` + `log_dispatch_change` | 0118_trip_timing.sql:58,293 |
| Alerts / boards | `notify()` (written only by triggers/doors, decision 145); boards read `trip_stages`, `trip_timing`, `pump_board`, `day_close_status` | 0209_trip_shared_status.sql:444; 0101_pump_coordination.sql:242; 0094_plant_flows.sql:197; DECISIONS.md:185 |
| Pump jobs | separate: `pump_job` + `pump_job_event`, steps `arrived, set_up, pumping_started, pumping_ended, left`, written by `pump_report()` (strictly in order, no implicit fill, `m3_pumped` only on `pumping_ended`) | 0084_field_app.sql:103,116,362-390 |
| Cancellations | `cancellation_case` and doors `open_trip_case`, `decide_cancellation`, `cancel_unproduced_order` | 0090_cancellations.sql:18,124,197,287 |

## 2. Driver PWA

Taps (`DRIVER_STEPS`, steps.ts:9-17): one big button per stage, in order. Each tap is queued on the phone with a key and sent to `/api/field/sync` (`field-service.ts:282`) which calls `driver_report` (:297), which calls `record_trip_stage`. Pump operator taps call `pump_report` (:311). Emergency calls `driver_emergency` (:304). Acknowledgement of an instruction calls `driver_ack_redirect`/`driver_ack` (:317-330).

Mapping to the SMS codes (proposal, not existing code):
- Mixer 1 = `loading_started`; 2 = `loaded` + `departed` (departed fills `loaded` implicitly, which the server already does); 3 = `unloading_started` (fills `arrived`); 4 = `unloading_finished` + `back`.
- Pump 1 = no stage today for "left for site" (pump steps start at `arrived`, steps.ts:79); 2 = `pumping_started` (fills `arrived`/`set_up` only if the writer is changed: `pump_report` refuses a skipped step, 0084_field_app.sql:383); 3 = `pumping_ended` (needs `m3_pumped`, CHECK at 0084_field_app.sql:126, so an SMS without a quantity would be refused); 4 = `left`.
- Hauler 1-4: no model (section 3).
- 5 emergency: nearest is `driver_emergency` with a fixed option list, no free "other"; 6 delay with minutes: `trip_delay` stores a reason, minutes are computed from timestamps, not typed; 7 other: not found.

Device binding, PIN, lockout, unlock (only needed for the PWA channel):
- Tables `driver_pin`, `driver_device` (one live device per driver) — 0084_field_app.sql:18,27,37.
- Login, bound-device check on every request, PIN lock: 0085_field_login.sql:23-40; atomic PIN attempt, 6+ digits: 0113_field_pin_atomic.sql, decision 173 (DECISIONS.md:239); `loginDriver` auth.ts:170; session fences 0213, 0216, 0222, 0227.
- Admin screen `/fr/admin/field` (field-admin.tsx; `setDriverPin` auth.ts:65, `revokeDriverDevice` auth.ts:89, unlock).
- Offline queue, 18 h limit, photo queue: `offline.ts`, `queue.ts`, `offline-store.ts`, `photo-queue.ts`.
An SMS channel does not use any of these; its identity is the sender number plus a gateway secret, so none of this would be touched, only bypassed. It must not weaken them.

## 3. Vehicle model

| Field | Present | Evidence |
|---|---|---|
| code (`T`/`P`/`X` + digits), plate, capacity_l, status | yes | 0027_truck.sql:9-17; 0078_plants.sql:67-71 |
| kind: `mixer`, `pump`, `external` | yes (pump trucks exist) | 0078_plants.sql:60 |
| plant_id (pump must have none), pay_basis (external only), stopped_decision | yes | 0078_plants.sql:58-66 |
| default driver | yes | 0074_default_driver.sql:9 |
| `hauler` kind (quarry-to-stock truck, e.g. no. 13) | **missing** (T12 not started; kind CHECK allows three values) | 0078_plants.sql:60 |
| Phone number on driver or truck | **missing** (`driver` has code, name, status only; phones exist only on client/supplier sealed, and on `plant`) | 0058_dispatch.sql:9-16; 0018_client.sql:47; 0020_supplier.sql:10; 0211_correct_office_plant_phone.sql:65 |
| GPS unit id | **missing** (no match for gps/imei in migrations) | grep |

A phone number could fit as a new sealed column on `driver` (pattern: `phone_enc`, 0018_client.sql:47, with key-rotation grant 0018_client.sql:73) or on a new link table sender → driver. A unit id would fit a nullable `truck.gps_unit_id` unique column. Neither exists.

## 4. Infrastructure

- **pg-boss:** only the scheduler: one-off schema install with the migrator URL (`job-scheduler.ts:15-27`), cron per catalogue job in Africa/Casablanca, `boss.work` (`job-scheduler.ts:83-84`). No inbound queue is used for external events. Option: an ingestion queue on the same pg-boss schema.
- **Inbound webhook (description only):** Caddy staging puts `basic_auth` on the whole vhost before `reverse_proxy`, with no path exemption (`Caddyfile.staging:3-4, 82`). A gateway cannot send a Basic credential it was not given, so either (a) the gateway is configured with the Basic user as well (header `Authorization` is stripped before the app, `Caddyfile.staging:91`, so the app must not rely on it), or (b) a named path matcher is exempted from the gate — which contradicts the "no path exemption" design and needs a decision. The app proxy sets headers for `/api/` (`proxy.ts:28-33`); the `/api/trips/stages` route enforces same-origin (`route.ts:16-27`), so a webhook needs its own route with a different gate (signature + timestamp + replay key), not that check. Request body capped at 12 MB at Caddy (`Caddyfile.staging:85`).
- **Audit and a service actor:** `audit_event.actor_kind` is `user | system | ai_confirmed` (0001_audit.sql:15); capture maps `ctx.role() = 'system'` to `system` (0003_audit_chain.sql:35, 0001_audit.sql:60). The `system` DB role is the app's seed/rotation role. An `sms_gateway` actor would be a `system` row with `actor_user_id` of a reserved user and a name in the row reason or `after`, or a new `actor_kind` value (needs a migration to the CHECK and the chain canonicalisation `audit.canonical_parts`, 0003_audit_chain.sql:25, which includes `actor_kind`). `record_trip_stage` raises when no user id (0209_trip_shared_status.sql:186-188), so a service identity needs a reserved user plus a new allowed role in that function.
- Rate limiting exists for login (`login-guard.ts`) and for the assistant (`limits.ts`); no limiter on an inbound endpoint exists.

## 5. Stock and recipes

| | Status | Facts and evidence |
|---|---|---|
| (a) Recipes: component qty per m³ per concrete class | **exists** | `recette` versioned, insert-only, per concrete type (0023_recette.sql:4); `recette_line.qty_per_m3` integer base units (0023_recette.sql:20); per plant (0105_recipe_per_plant.sql:1). Components have base unit g / mL / L (0021_component.sql:13); grades are separate components (seed: Gravette 8/15, 15/25; Eau, Adjuvant, pilot-seed.ts:68-97). |
| (b) Stock per plant per component, movements | **exists** | `stock_movement` signed, insert-only, plant_id (0042_stock_movement.sql:6; 0078_plants.sql:84). Sources: delivery, receipt, count_adjustment, opening, reversal, transfer_out, transfer_in (0094_plant_flows.sql:7-9). Level = sum of movements (`getStockLevels`, stock-service.ts:46). No separate stock table. Transfers: `plant_transfer` sent/in_transit/received with received quantity (0094_plant_flows.sql:12). |
| (c) What triggers consumption | **exists, on the BL** | Consumption is written when the plant creates the load (BL): `createLoadInTx` → `insertLoadRows` (delivery-service.ts:120,205) writes the `delivery` row and one `stock_movement` per recette line; the DB checks each line and completeness at commit (stock_movement_guard, `delivery_has_movements`, 0042_stock_movement.sql:62-140). The driver's `loaded` tap does NOT write stock (0209_trip_shared_status.sql:4-6, "declared"). Units: volume in litres, quantity = `scale_qty(qty_per_m3, volume_l, 1000)`, one rounding per line, half away from zero (0042_stock_movement.sql:53-58). Cancelled load: `cancelLoad` (delivery-service.ts:279) writes reversing movements equal and opposite (0042_stock_movement.sql:79-90). Refused/returned concrete: `delivery_loss` records litres and reason but explicitly does not give components back (0063_delivery_loss.sql:1-3). |
| (d) Receipts increase stock | **exists** | `record_receipt()` writes `purchase_receipt` and receipt movements (0045_purchase_receipt.sql:7,36); two-step: plant confirmation `receipt_plant_confirmation` (0078_plants.sql:265) and arrival lines (0100_receipt_states.sql:6); variance office vs plant with threshold 200 bp and notification (0106_receipt_variance.sql:1-5). Hauler deliveries: **missing** (no hauler kind, no haul log; T12). |
| (e) Physical count vs theoretical, tolerance, alert | **partial** | Count: owner/app_admin only (`stock.count`, permissions.ts:345); computes difference against the movement sum and writes one `count_adjustment` with a mandatory reason (stock-service.ts:182-225). **No tolerance parameter, no per-component variance alert.** Day close lists counted/corrected components as a blocking `stock_variance` item (0094_plant_flows.sql:216). The 2 % variance exists only for receipts, not counts. Plant manager cannot count (`stock.count` excludes `plant_manager`). |
| (f) Reorder thresholds and request to purchases | **partial** | Threshold per component and plant: `stock_threshold` latest row wins (0045_purchase_receipt.sql:15), derived default from lead time and 30-day consumption (`getReorderThresholds`, stock-service.ts:291-340), `rules-engine/domain/reorder.ts`. `purchase_plan_item` exists (0044_purchase.sql:54). **No plant_manager → office_purchases request object** (UI-ROLE-INVENTORY-2026-11-13.md; LEAD-HANDOFF.md:164). |
| (g) Fuel tank | **exists** | `fuel_tank_opening` (0104_fuel_tank.sql:6); level computed, never stored; fills per truck `fuel_fill` (0062_fuel.sql:7); fuel transfers; day-close lines `fuel_transfer_variance`, `fuel_tank_negative` (0107_day_close_fuel.sql:27-33). |
| (h) Seed | **exists** | Fictitious components, recettes B20/B25/B30 with assumed quantities (pilot-seed.ts:68-97), purchase prices (:104-111), opening stock = 25 % of used, thresholds, receipts to reach a target end level (pilot-ops.ts:136-230); runs as the seed/system actor. |
| (i) Import from the plant's batching software | **missing** | Master-data Excel importer and history importer (deliveries, expenses) exist (IMPORT-EXCEL.md:88-96); history "never decrements live stock" (IMPORT-EXCEL.md:90). Direct integration with plant software is out of scope in the brief (BRIEF.md:69). Real quantities per batch are not a model today: consumption is computed from recette × volume. |

## 6. Supplier-portal-inspired gaps (from `docs/lead-notes/STUDY-MYCIMAR-PORTAL.md`)

| Item | Status | Evidence / note |
|---|---|---|
| Owner home: 3 money cards, red alerts, monthly curve | partial | One home per role; money dashboard for owner/app_admin (LEAD-HANDOFF.md:164); SPEC-owner-dashboard.md exists. Cards and curve not confirmed in this pass. |
| Order statuses Created/Confirmed/In process/Delivered/Done/Cancelled | partial | Order chain order → dispatch → load → delivered exists (0073_order_chain.sql, 0064_delivered.sql); a single named status set like the portal's was not found. Cancelled exists (reversal). |
| BL fields: time, plate, driver, site, quantity, client PO number | partial | BL with truck, volume, date, client name (0043, 0056); `delivery.loaded_at` available. **Client PO number column: not found.** |
| Consumption view month × product × quantity × HT | partial | `consumption-report.ts`, reports page exist (src/modules/operations/domain/consumption-report.ts); month × product × HT not confirmed. |
| Fortnightly invoicing | missing | invoice queue / from deliveries exist (0066, 0067); no 15th/month-end cadence found. |
| Excel / PDF export coverage | partial | CSV export routes: accounting and statements only (`accounting/export/route.ts`, `statements/[kind]/[id]/export/route.ts`); PDF: ledger documents and delivery note (`ledger/pdf/documents.ts`, `operations/pdf/delivery-note-pdf.ts`). No export on stock, deliveries, receipts lists. |
| Supplier reconciliation BL → receipt → invoice → payment | partial | `supplier_invoice` linked to purchase and receipts, with match (0070_supplier_invoice.sql:8,53; 0071_supplier_invoice_match.sql); supplier BL number as a field: not found; supplier payments 0048. |
| Numbered supplier purchase order | exists | `purchase.code` `ACH-YYYY-nnnnn` (0044_purchase.sql:10). Not sent to / entered in the supplier portal, no link field. |
| Price per tonne history + rise alert | partial | `purchase_price` versioned by effective date, unit-based (0024_purchase_price.sql:5); history exists; **no rise alert found**. |
| Duplicate cheque reference check | exists | Unique index on (direction, method, bank, number) for cheque and LCN (0037_payment_instrument.sql:31). Bank transfer references not covered. |
| List of authorized delivery destinations | partial | `client_site` for clients (0019_client_site.sql:4); no supplier-side list of allowed destinations for bought cement. |

## 7. Gap table for the SMS design

| Need | Already exists | New table or door | Permission change | Conflicts with decision |
|---|---|---|---|---|
| Raw message log (insert-only, untouched text, sender, received_at, gateway id) | no | new table + insert door for a service actor | new service role/permission | audit chain canonicalisation (hash chain, 0003_audit_chain.sql) |
| Parser (codes 1-7, optional minutes, free text) | no | code (pure function) + tests | none | D141/D135 define the phone flow; SMS adds a channel, review needed |
| Sender → driver/vehicle mapping | no (no phone on driver) | new sealed column or link table | owner/app_admin only to edit | CNDP: phone numbers of workers (LEAD-HANDOFF.md:50), privacy notice |
| Stage-order validation | yes for mixer (`record_trip_stage` implicit fill, idempotent) | pump path needs a variant (pump_report refuses skipped step) | writer must accept a service actor | D179 timing; T9 doc `T9-TRIP-SHARED-STATUS.md` |
| Which trip is "current" for a sender | no | rule: single open trip of the truck today, else ambiguous → inbox | none | D179 dispatch |
| Unknown / ambiguous message inbox | no | new table + screen for plant_manager | plant_manager reads own plant | — |
| Unified `source` sms/gps/office/pwa | partial: `source` driver/plant/admin | CHECK change on `trip_event.source` and `actor_role` | none | T9 semantics ("driver" = PWA); migration with whole-tuple/definer catalogue tests |
| Vehicle registry: hauler kind, phone, gps_unit_id | no | `truck.kind` CHECK, new columns | owner/app_admin edit | T12 not started; 0078 `truck_code_kind` regex (`T/P/X`) needs a new prefix |
| Emergency (5), delay minutes (6), other (7) | emergency yes, delay reason yes, other no | free-text capture; minutes column | notification routing | D145 notify rules |
| Hauler stages 1-4 | no | haul log tables (T12) | new | T12 |
| Service actor in audit | `system` kind exists | reserved user + role in `record_trip_stage` or new `actor_kind` | new role | audit chain format; R-series gates |
| Signed inbound endpoint outside Basic Auth | no | new route + signature/replay check | Caddy path exemption | staging design "no path exemption" (D223/D229) |

## 8. Risks

1. **Spoofing / replay:** SMS sender id is forgeable; gateway signature, timestamp window, unique message id and a rate limit are mandatory. Not yet built (SECURITY-DEBT row on the signed-secret check).
2. **Basic Auth gate vs gateway:** exempting a path weakens the "whole vhost" rule; alternatives need an explicit decision.
3. **Stage truth:** SMS "2 left loaded" would imply `loaded`; today `loaded` is only declared and never writes stock (0209:4-6). Stock must stay triggered by the plant's BL, never by an SMS.
4. **Worker data:** per-driver timestamps are CNDP-regulated (LEAD-HANDOFF.md:50); a phone number mapped to a person widens that file.
5. **Ambiguity:** two open trips for one truck, a driver with a pump and a mixer, messages out of order, duplicated SMS.
6. **Consumption by recipe, not measured:** no batching-software data, so stock variance cannot be validated until counts have a tolerance and an alert (section 5e).
7. **PWA bypass:** SMS must not create a path that skips device binding for the PWA; it is a separate identity.

## 9. Proposed order of small tasks

1. **Spec only:** message grammar (codes 1-7, minutes), mapping rules, state machine for ambiguity, privacy and audit design, decision numbers; Ali approves.
2. **Migration A:** vehicle registry additions (hauler kind, gps_unit_id, sender mapping) with tests.
3. **Migration B:** raw message log + unknown inbox + service actor, definer door, audit coverage.
4. **Ingestion:** signed webhook route, rate limit, replay key, parser (pure), writer to `record_trip_stage`/pump equivalent, behind a flag; fictitious gateway simulator.
5. **Boards:** inbox screen for plant_manager, source badge on stages, delay/emergency alerts; then stock items: count tolerance + alert, reorder request to office_purchases, then hauler log (T12).
6. Each step adds a row to `docs/SECURITY-DEBT.md` for anything deferred.

## 10. What could not be verified in this pass

- Owner home cards/curve contents, order status naming and the month × product × HT view were not opened in the UI code.
- Rate limiting on any inbound public endpoint: none found; not exhaustively searched.
- Numbers D141 / D135 / D145 / D173 / D179 are cited from `docs/DECISIONS.md` summaries, not re-read in full.
