# SPEC — SMS driver channel and GPS hook (D231, D232, D235)

Status: DRAFT for Ali's approval (T14, 15 Nov 2026). Docs only. Fictitious data only (numbers below are invented placeholders).
Source: D231, D232, D235, `docs/LEAD-HANDOFF.md` §4, `docs/reviews/SMS-GPS-STOCK-INVENTORY-2026-11-15.md` §1–4, §7–8.

## 1. Purpose
Every driver and pump operator reports stages by SMS (no smartphone), through one receiving number. The server validates, stores the raw message, writes the stage through one narrow door, and shows it on the plant manager's and office boards. The phone PWA is deferred, not deleted, and is never bypassed or weakened.

## 2. Scope
In: grammar and code table, sender-to-vehicle mapping, ambiguity state machine, service actor `sms_gateway` and its door, signed webhook, raw log, office inbox, webhook gate options (OPEN), privacy/CNDP, GPS `PositionSource` hook.
Out: the gateway phone setup procedure, SMS replies billing, the GPS provider integration itself, WhatsApp.

## 3. Message grammar
Plain text received at the gateway. Normalisation (pure function): trim, Unicode NFKC (full-width digits → ASCII) plus an explicit map of Arabic-Indic and Persian digits (NFKC does not convert them; corrected in T15 G3, `normalizePhoneE164` does the same for numbers), collapse whitespace, ignore case, strip trailing punctuation. Grammar:
`message := code [SP minutes] [SP free_text]`; `code := 0..7`; `minutes := 1..3 digits` (only meaningful for 6, 1–600). Anything else (empty, letters first, code > 7, two codes) → **unparseable** → inbox.
| Code | MIXER | PUMP | HAULER (truck 13) |
|---|---|---|---|
| 1 | start loading | left for site | start loading at the quarry |
| 2 | left loaded | start pumping | left loaded |
| 3 | start unloading | end pumping / cleaning | start unloading at the stock |
| 4 | unloading done and returning | returning | done and returning |
| 5 | emergency (all types) | | |
| 6 | delay, optional minutes (`6 30`) | | |
| 7 | other (free text kept) | | |
| 0 | correction of the previous message | | |
Pump and hauler columns are proposals to confirm with the plant managers. A code card per cab is printed from this table (idea backlog).
Mapping to the existing writer: mixer 1 → `loading_started`; 2 → `loaded` + `departed` (implicit fill exists); 3 → `unloading_started` (fills `arrived`); 4 → `unloading_finished` + `back`. Pump: today `pump_report()` refuses skipped steps, has no "left for site" and requires m³ at `pumping_ended`; the SMS path needs a variant of the pump writer (implicit fill, nullable m³ completed later by the plant manager, new step `left_for_site`) — this is a migration item, not assumed to exist. Hauler: no model until T12. Code 6 minutes are stored as the driver's declared delay next to the computed delay; code 5 creates an emergency with the generic option "other" and raises the existing emergency notification at once; code 7 stores free text on the event and in the inbox for reading.
**Stock invariant:** an SMS never writes `stock_movement`. Code 2 (loaded) is a declaration; stock moves only on the plant's BL (see `SPEC-stock-engine-gaps.md` §3).
**Code 0 (correction):** marks the sender's previous accepted event as `disputed` and puts a task in the inbox; it deletes nothing. The office/plant_manager confirms a correction through the existing `trip_event_correction` mechanism (new row, reason, audited). Stage rows are never rewritten.

## 4. Sender-to-vehicle mapping
- Registry (D235): the existing `truck` table (there is no `vehicle` table; kinds today are mixer / pump / external with codes T/P/X, `0078`), gaining kind hauler, plate, plant, assigned driver, driver phone, optional `gps_unit_id`. New hauler kind and phone column; the truck code regex (T/P/X) gets a hauler prefix. Mapping table `sms_sender` (phone_hash for lookup, phone_enc sealed with the existing key-rotation pattern, driver, vehicle, valid_from/valid_to, active). Lookup is by a keyed hash (HMAC with a server secret) of the E.164-normalised number; the clear number is never stored in the raw log index.
- A number maps to exactly one active driver at a time; one driver may have two numbers (own and spare) only if the owner/app_admin registers both. A driver assigned to a mixer today and a pump tomorrow follows the assignment of the day (vehicle assignment per day exists in dispatch).
- Edit rights: owner and app_admin only (audited). A new/changed number needs a typed reason. Unknown numbers are never auto-registered.
- Weak identity accepted: the sender number can be spoofed (SMS sender id); mitigated by the gateway signature (the attacker would have to reach the gateway), plausibility (stage order, vehicle state), rate limit, and office review of surprises.

## 5. Ambiguity state machine
Each inbound message gets a status: `received → parsed → (accepted | ambiguous | rejected_unknown | unparseable | duplicate | out_of_order)`.
1. **Duplicate:** same gateway message id, or same (sender, normalised text) within 90 s → `duplicate`, no write, no reply storm (one "OK" only).
2. **Unknown sender** → `rejected_unknown` → inbox (office sees number masked except last 3 digits; raw text kept).
3. **Unparseable** → inbox, driver gets "Message non compris. Envoyez un chiffre de 1 à 7." (fr, short).
4. **Resolve trip:** the sender's vehicle's open trips of today (plant day, Africa/Casablanca). Exactly one → use it. None → `ambiguous` ("no trip": inbox, plant_manager attaches or ignores). Several → pick the one whose **next expected stage** equals the code's stage; exactly one match → use it; else `ambiguous`.
5. **Order validation:** next stage or any later stage → accepted (later fills skipped as implicit, existing behaviour); a stage already recorded → idempotent "already recorded" (no error); an earlier stage than the latest → `out_of_order` → inbox, no write.
6. **Accepted:** write through the door (§6), reply "OK <short stage label>".
7. Codes 5/6/7/0 need no stage order; they attach to the open trip if resolvable, otherwise to the vehicle and the inbox.
All transitions are logged on the raw row (insert-only status events). Ambiguous items never block anything; they wait for a human.

## 6. Service actor `sms_gateway` and its door
- A reserved, non-login user `sms_gateway` (no password, no sessions, no TOTP; cannot sign in) with a new DB role/permission set that is only allowed to execute the doors below. Audit rows use `actor_kind = 'system'` with the reserved user id, and the row's `after` records channel `sms`, raw message id and sender mapping id (or a new `actor_kind` value if the audit canonicalisation is extended, decided at M-B; the existing chain is never weakened).
- **Door `sms_ingest_event(raw_id)`** (SECURITY DEFINER, actor-first, whole-tuple): takes only a raw message id; re-reads the stored raw row itself (the caller cannot pass trip, stage or time); resolves sender/trip/stage per §5; calls the same stage-writing logic as `record_trip_stage` with `source = 'sms'` and `actor_role = 'sms_gateway'` (CHECK changes: allowed source/actor_role values; whole-tuple test). It cannot touch stock, money, prices, users or any other table. Server receive time is the stage instant; the gateway-reported time is stored apart.
- Second door `sms_attach_raw(raw_id, trip_id)` is for plant_manager/office (human) to resolve inbox items; it writes the event as the human actor with `source='plant'` and the reason, not as `sms_gateway`.
- The definer catalogue test lists both; negative sweep proves every other role is refused and `sms_gateway` is refused everywhere else.

## 7. Signed webhook
- Route `POST /api/sms/inbound` (own route, **not** the same-origin check of `/api/trips/stages`; Better Auth origin protections stay untouched elsewhere).
- Gateway sends JSON: message id, sender, text, gateway timestamp (apps such as textbee/httpSMS/SMSGate support a custom header or webhook signature; exact fields to confirm with the chosen app). Check, in order, cheap first: method and content-type, body cap 8 KB (before parsing), per-IP and global rate limit (new limiter, e.g. 60/min), **HMAC-SHA256 of timestamp + raw body with a shared secret, compared in constant time** (secret in env/secret file, never in git; rotation = two accepted secrets during a window), timestamp within ±5 min, unique gateway message id (replay key; replay → 200 with "duplicate", nothing written).
- On pass: insert the raw row, enqueue a pg-boss job `sms.ingest` (new inbound use of pg-boss), return 202 fast. The job runs the door. Failure after N retries → status `failed` on the raw row + owner/app_admin notification.
- Any signature failure: 401 with no detail, counted; N failures in 10 min raises an alert (someone is probing). SECURITY-DEBT row: webhook rate limit/secret rotation procedures, verified at the final audit.

## 8. Webhook gate (OPEN decision for Ali, needs a numbered decision before ingestion is built)
Staging Caddy puts Basic Auth on the whole vhost with no path exemption (`Caddyfile.staging`, D223/D229). A gateway app must reach the webhook:
**Option 1 — Gateway gets its own Basic credential.** The gateway app sends `Authorization: Basic …` (if the app supports custom headers/basic URL credentials) in addition to the HMAC signature. Pros: the "whole vhost" rule and its tests stay intact; no new exposure; revocable independently. Cons: Caddy strips `Authorization` before the app (`Caddyfile.staging:91`) so the app cannot see/rely on it (fine: HMAC is the app-level check); the credential must be stored on the gateway phone; Caddy supports one `basic_auth` block per matcher, so a second user is added to the same hash file (the `staging/` allow-list and rotation scripts need to treat two users); not all gateway apps can send Basic credentials; rotation touches a phone in the field.
**Option 2 — Explicit Caddy path exemption for `/api/sms/inbound` only.** A named matcher skips Basic Auth for that exact path/method (POST); security rests on the HMAC, timestamp, replay key, body cap and rate limit. Pros: works with any gateway app; no credential on the phone besides the HMAC secret. Cons: contradicts the "no path exemption" design and its tests (they must be rewritten with an explicit allow-list entry); the endpoint becomes world-reachable (probing, DoS surface, log noise); an exemption written too loosely (prefix, any method) would expose more; the final audit must verify it.
Mitigation common to both: IP allow-list is not usable (mobile gateway IP changes). A third variant (a separate hostname/port for the gateway) is possible but not listed as an option: it adds a second vhost and certificate to maintain.
**Recommendation (not a decision):** Option 1 if the chosen gateway app can send a Basic header; otherwise Option 2 with the narrowest matcher (exact path, POST only) and a test that every other path still returns 401. Production decision stays separate from staging.

## 9. Raw log and office inbox
- `sms_raw` (insert-only): id, gateway message id (unique), received_at (server), gateway_time, sender_hash, sender_enc (sealed), text (as received, length-capped), signature_ok, status, status events (separate insert-only table), resulting `trip_event` id or inbox id. Retention: configurable (proposal 12 months, then purge by a reviewed job); no hard delete by users.
- `sms_inbox_item`: raw id, reason (unknown, unparseable, ambiguous, out_of_order, correction, other_text, emergency_unresolved), plant, status open/resolved/ignored, resolved_by, resolution note. Screens: plant_manager sees items of his plant (own vehicles); office_sales/office_purchases do not (they are not dispatch roles since T8); owner/app_admin see all, including unknown numbers. Resolve actions: attach to trip, register number (owner/app_admin only), ignore with reason. Emergency/delay codes raise immediate notifications to the plant manager of the vehicle's plant, owner and app_admin.

## 10. Privacy, CNDP, audit
Drivers' phone numbers and per-driver timestamps are personal data of workers: HR/work-organisation filing (AUTHORIZATION; the lead's 7 Nov research; unverified, needs a Moroccan lawyer/CNDP). Drivers are informed in writing and keep access/rectification rights. Phone numbers stored sealed; lookups by keyed hash; boards show vehicle and driver name, never the number except to owner/app_admin. Delay data readable only by that driver's plant manager, owner, app_admin (T5 rule). Raw text may contain anything a driver types: the inbox is access-controlled and free text is never sent to an AI. Audit: every door call writes the hash-chained audit row. SMS content crosses the operator network in clear: no secrets or personal details are requested by the protocol (digits only).

## 11. GPS `PositionSource` adapter hook (D232)
Interface (types only, no provider code now): `PositionSource.latest(unit_id) / subscribe` returning `{unit_id, lat, lon, speed, ignition, timestamp}`; `truck.gps_unit_id` maps unit → vehicle explicitly (the account has 17 units incl. non-fleet; unmapped units are never auto-assigned). KAYAS holds site coordinates (plants, quarry, stock, worksites with radius) and computes departed/arrived/returning and ETA itself; positions **corroborate** SMS events and set a "to confirm" flag on a mismatch (e.g. SMS "arrived" while vehicle is 8 km away); they never block and never write stock. Positions are stored only as needed (proposal: last position + events, short retention) and are personal data of named drivers.
Scenarios by the provider's answer: **A** API/forwarding → direct adapter with a dedicated read-only user; **B** no API but trackers can send to a second server → self-hosted Traccar forwarding to a KAYAS webhook (must not disturb the existing platform; the same signed-webhook pattern applies); **C** neither → SMS only, ETA from the T5 medians (last 10 rotations, min 5), optional import of report exports; **D** cheap Android phones with a tracker app (13 phones; the driver could switch them off). Scraping the web interface is rejected. Questions for the provider are in the handoff §4.

## 12. Edge cases
Two SMS for one stage seconds apart; a driver texting from another driver's phone (maps to the owner of the number: office corrects); a driver with two vehicles in a day; trip created after the SMS arrived (ambiguous → inbox, reprocessed when attached); network delay delivers SMS hours late (receive time used; flag if > 30 min after the previous event, since gateway time is stored); gateway phone offline (messages queue at the operator; backup phone on another operator posts through the same webhook, distinct gateway id); SIM change; a driver sending `6` without minutes; `6 0`, `6 9999` (rejected range); text with Arabic digits; very long text (cap); out-of-hours messages; reply SMS failing (the event is already written; the reply is best effort); correction `0` after an accepted `4`.

## 13. Test plan
Unit: normalisation and parser table-driven (all codes, Arabic digits, `6 30`, junk), state machine transitions, trip-resolution cases. Integration (DB): door refuses wrong caller/role; `sms_gateway` cannot read or write anything else; whole-tuple and definer catalogue; replay key uniqueness; implicit fill through the door equals the PWA path; invariant: no `stock_movement` change; audit row per call. Webhook: bad signature, stale timestamp, replay, oversize body, rate limit, wrong method, valid → 202 and one raw row. E2E with a **fictitious gateway simulator** (script posting signed messages): full mixer rotation 1–4, ambiguous, unknown number, duplicate, correction. Caddy test for the chosen gate option (Option 2: exact-path exemption only, all other paths 401).

## 14. Open questions
1. **Webhook gate: Option 1 or Option 2 (Ali decides; numbered decision needed).**
2. Final code lists for pump trucks and truck 13 with the plant managers; is "left for site" for pumps worth a new step.
3. Who pays the SMS; personal vs company SIMs; who hosts the gateway phone and the backup (other operator).
4. Which gateway app (textbee, httpSMS, SMSGate…) and whether it can send a signature and/or Basic header.
5. Informing drivers; CNDP filing wording; raw-log retention period.
6. Does the driver get an SMS reply (cost) or only errors?
7. GPS: ALLO GPS answers (API/forwarding, fields, refresh, read-only user, price, tracker model).

## 15. Proposed migration / task order
1. Spec approval + numbered decision for the webhook gate.
2. M-A vehicle registry (hauler kind, phone sealed, `gps_unit_id`, truck code prefix) + `sms_sender` + tests.
3. M-B `sms_raw`, status events, `sms_inbox_item`, `sms_gateway` user/role, `trip_event.source/actor_role` CHECK extension, `sms_ingest_event` and `sms_attach_raw` doors, pump writer variant, audit coverage.
4. Ingestion: webhook route, limiter, HMAC check, pg-boss job, parser, flag-gated, gateway simulator.
5. Boards: inbox screen, source badge on stages, emergency/delay alerts.
6. Gateway phone, code cards, driver notice.
7. GPS adapter later (D232).
**Security-debt rows added with this spec:** webhook gate choice (accepted risk until decided/built) and webhook rate-limit/secret-rotation verification.
