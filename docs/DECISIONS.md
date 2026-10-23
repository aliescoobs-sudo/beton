# DECISIONS.md — BELGOBETON

Legend: ✅ confirmed by Ali · 🟡 assumption (reasonable default, revisit with real data) · ⛔ superseded

## Principle
0. ✅ **Security and privacy first** in every phase (research, spec, plan, build). Any feature that conflicts with it is postponed.

## Scope and users
1. ✅ Single company in Tetouan, not SaaS.
2. ✅ Users: owner, partner, 2 office staff, plant operator.
3. ✅ Orders come from owner + partner; they inform office and plant.
26. ✅ Intent statement confirmed.
49. 🟡 Company size: ~20M MAD/yr, ~25,000 m³/yr, 5 trucks, ~60 clients, ~8 suppliers.

## Data entry and flows
4. ✅ Two input logics: plant enters per batch (e.g. 30 m³ = 3 loads); our app enters per order (client, type, m³, price/m³, total, payment plan).
5. ✅ Orders are entered as soon as known (days/weeks ahead) with the delivery date.
6. ✅ Reconciliation runs on delivery date: planned (ours) ↔ actual (plant) ↔ physical count.
7. ✅ Each concrete type has a recipe; component stock is deducted automatically.
8. ✅ Purchase price per component (various units) and selling price per type → margin per delivery.
9. ✅ Payment plan per transaction: method, number of payments, dates.
14. ✅ Distinguish real cash received vs total including uncleared cheques.
15. ✅ Plant integration is NOT required for MVP; independent double entry is intentional, as a control.
27. 🟡 Payment methods: cash, cheque, LCN, transfer, advance, installments.
28. 🟡 Instrument lifecycle: received → deposited → cleared / bounced → 30-day window → regularized / dispute.
29. 🟡 Rule: post-dated cheques may be presented early (worst case treated as risk). Severity of worst-case-only deficits → see 63.
54. 🟡 Plant data via Excel/CSV import (one row per batch: date, recipe, quantity) with column mapping, or manual daily totals.

## Intelligence
10. ✅ Client/supplier color by payment status.
11. ✅ Alert ≥ 2 days before installments: "urgent" if we pay, "probable" if we receive.
12. ✅ Cash-flow forecast from opening cash + payables + receivables.
13. ✅ Agent loop: alert + summary report → owner replies (more info / reclassify / command).
21. 🟡 Status colors: 🟢 fully paid · 🔵 on schedule · 🟡 due ≤ 2 days · 🔴 late or bounced · ⚪ cancelled.
22. 🟡 Alert severity: 🔴 risk · 🟠 urgent · 🟡 important · 🔵 probable.
38. 🟡 Risk detection = deterministic rules engine; AI only explains, summarizes, interprets replies.
58. 🟡 AI roles: assisted entry, daily brief, risk reports, owner Q&A (read-only tools), reconciliation anomaly explanations.

## Security and privacy
33. ⛔ (money part superseded by 81) RBAC: owner/partner see all; office sees only their transactions (no margins, no global cash); plant sees production and stock only. Office scope clarified → see 60. Still valid: plant sees production and stock only; the audit log, immutability and 2FA rules.
34. 🟡 Immutable audit log; no hard deletes; cancellation = reversing entry.
35. 🟡 2FA for all accounts.
36. 🟡 Encryption in transit and at rest; daily encrypted backups with regular restore tests.
37. 🟡 Pilot uses fake data only; real data only after a security checklist passes.
39. 🟡 Comply with law 09-08 (CNDP declaration + authorizations).
59. 🟡 AI safety: pseudonymization before any AI call, data minimization, no AI action without human confirmation, AI actions logged, stored text treated as data (prompt-injection defense), provider abstraction, per-feature kill switch, no cheque images sent to external AI.
51. 🟡 Production: request ZDR; no Batch API; no models requiring retention.
52. 🟡 Production database hosted in Morocco; CNDP authorization for pseudonymized data sent to the AI provider.
56. 🟡 Monthly AI budget cap with alert.
57. 🟡 Do not store national ID (CIN) numbers in MVP.

## Product shape
19. 🟡 Pilot scene: "black day" scenario over a simulated week + dashboard as the brain's home.
20. ⛔ Full alerts in Telegram → replaced by 40.
40. 🟡 Telegram alert with no sensitive data; details and replies inside the app behind 2FA; in-app push too.
41. 🟡 Responsive web app (PWA); no native app in MVP.
42. 🟡 Pilot hosting: any managed cloud (fake data).
43. ✅ (2026-10-20) Stack: TypeScript full-stack (Next.js) + PostgreSQL with Row-Level Security + scheduled jobs + Telegram bot + swappable AI layer (see CAPABILITY-MAP §3). Database access is SQL-first for all business tables: hand-written SQL migrations (tables, RLS, grants, triggers, checks) and typed `pg` queries with Zod row parsing. Drizzle is kept only as the migration runner (`drizzle-orm` migrator in `scripts/db-migrate.ts`); there are no Drizzle table schemas.
44. 🟡 Simulation clock in pilot.
45. 🟡 Trucks in MVP: list + warning when planned loads exceed daily trip capacity.
48. ✅ UI languages: French + Arabic both in the pilot, Arabic in RTL; Darija accepted as AI input; financial terms in French as used in the office (confirmed 2026-10-18).
50. 🟡 AI: Claude Haiku 5.5 (light tasks) + Sonnet 5.5 (analysis); Mistral as comparison; final pick after a ~50-example Darija/French eval.
53. 🟡 Simulation zones (one way): Tetouan center 20 min, Martil 25, M'diq 30, Fnideq 45, Oued Laou 60; + 30 min unloading.
32. 🟡 Configurable parameters: 90-min concrete limit, 30-min unloading, capacity per truck (default 8 m³).

## Spec review answers (2026-10-18, see CAPABILITY-MAP.md §10)
60. ⛔ (superseded by 81, provisional) (A9) Office sees all operational records needed to record payments (orders, deliveries, instruments, invoices, purchases), but no margins, cash position or forecast (nor costs or risk alerts). Replaced by blind entry: office writes money records but cannot read them back. Deliveries and BL stay readable (not money).
61. ✅ (A11) Plant operator creates loads (BL) at dispatch; whoever receives the signed BL (plant operator or office) records its return; double recording is prevented; the audit log shows who.
62. ✅ (A13) Worst-case forecast = normal forecast with outgoing post-dated instruments counted as liabilities from their issue date (dated max(issue date, today)), consistent with R11.
63. ✅ (A14) 🔴 risk only for deficits in the normal forecast; 🟠 for worst-case-only deficits.
64. ✅ (A15) Overdue receivable alert = 🟠; the account colour stays 🔴 when an installment is overdue (R14).
65. ✅ (A23) AI never writes financial records; AI actions are limited to alert actions and drafting (never sending) client messages; assisted entry only prefills forms and a human saves.
66. ✅ VAT rate (`vat_rate_bp`, 20% in the simulation) and cheque/LCN clearing delay (`clearing_delay_days`, 1 working day in the simulation) are configurable parameters, never hard-coded; each document stores the VAT rate in force when created.
67. ✅ (A27) Per-client selling-price overrides allowed, with a mandatory reason; audited. 🟡 Owner only since 81 (partner has no money access); it was owner and partner.
68. ✅ (ADR 0001, 2026-10-18) Auth library: Better Auth 1.7.7 pinned exactly; every upgrade re-runs the full auth test suite. Gaps closed by tested hooks: 12 h absolute session cap, per-account/IP login lockout, no trust-device bypass, TOTP replay refused, mandatory 2FA enrolment, step-up timestamp.
69. ✅ Recovery codes stored encrypted with a dedicated key that never lives in the database; single-use; shown only once at generation; regenerating invalidates the old set; every use audited.
70. ✅ Sessions always run on real time, even in simulation; tests fake the system time.
71. ✅ (CP3) `@better-auth/utils@0.4.2` approved as a direct, pinned dependency (OTP helper for TOTP replay protection).
72. ✅ (CP3) After a recovery-code login, sensitive actions need a real TOTP, and the user must first enrol a new authenticator and receive a new recovery-code set.
73. ✅ (CP3) Enrolment shows a QR code generated server-side by a pinned, well-maintained library; the TOTP secret is never sent to an external service; key + otpauth link stay as fallback.
74. ✅ (CP3) User creation is retry-safe: the user stays disabled until its credentials are written; a failure is audited and a retry completes it.
75. ✅ (CP4) Owner break-glass: `user:reset-owner-2fa` CLI, server-only, requires the database superuser password, audited, and every use sends an alert to the owner and the partner.
76. ✅ (CP4) Defence in depth: the database checks the request role set by the app against the user's stored role (Phase 4).
77. ✅ (CP4) Interrupted re-enrolment: the old authenticator and old recovery codes stay valid until the new authenticator is confirmed; the swap is atomic at confirmation.
78. ⚠️ (CP6, known limitation, simulation only) `clock.advance` moves `sim_now` to a job's instant and then runs the job. A failed job is retried by the next advance, because its run row exists at `sim_now`. If the process dies right after `sim_now` moves and before the run row is written, no row exists, the next advance starts after that instant, and the job is skipped for that day. Accepted for the pilot: the clock is simulation-only and the owner sees the gap in the job-run history. A fix would write the run row (or move the clock) in the same transaction as the start of the job.
79. ✅ (CP-M1) Migrations create structure only. Fake data, including reference values that are still assumptions (e.g. zones and their times, 🟡 D53), comes only from the pilot seed, which refuses to run with `REAL_DATA=true`.
80. ✅ (T10–T15 review) The pilot seed has its own login role, `belgobeton_seed` (`DATABASE_URL_SEED`, in `.env.ops`). `db:bootstrap` creates it only with `SIMULATION_ENABLED=true` and neither `REAL_DATA` nor production, and switches an existing one to NOLOGIN otherwise. Its grants (SELECT/INSERT on master data, the code counter, `audit.record`) are in `db/seed/seed-role.sql`, applied after the migrations only where the role can log in. `belgobeton_system` never inserts master data, bumps counters or reads prices (migration 0029); the table-access meta-test enforces both.

## Money visibility (2026-10-23, provisional, to be confirmed by the owner on 2026-10-24)
81. 🟡 **Money visibility.** Money data = balances, totals, forecasts, client and supplier balances, payment instruments, invoice amounts, prices (selling, purchase, overrides, order and purchase totals, plan items, cost and margin). It is enforced in the database (RLS policies and column grants keyed on the request role, D76), not only in the UI; every money table and view has a test proving the roles below get zero rows.
    - **owner**: reads and writes all money data; the only role that confirms, approves or posts a money action (confirmations, corrections, price changes, overrides).
    - **support** (new role, the technical companion): reads all money data, and every other table; read-only everywhere; can never confirm, approve or post a money action (no INSERT/UPDATE grant path, no permission in the write lists); 2FA mandatory (D35); every session and every view of a money screen is audited; the owner can disable the account at any time (`users.manage`). Money views are audited by the app (a database cannot log plain reads): every money read goes through one service that records the view event first.
    - **office**: blind entry. Can create invoices, payments received, cheques/LCN received and expenses; after saving it cannot read them back: no lists with amounts, no balances, no totals, no forecast, no prices. Writing a row never returns an amount. A correction is a request to the owner (a record with the document code and a reason, no amount); office cannot reverse.
    - **plant**: stock, deliveries in m³ and recettes only; no price, no money. Unchanged.
    - **partner**: no money access for now, until the owner decides. Keeps operational (non-money) rights: trucks, zones, components, recettes, concrete types, clients and suppliers without balances, reconciliation.
    Supersedes in part: 33, 60, 67 (and the "Partner's exact permissions" open question for money). Consequences recorded in tasks/plan-ledger.md (Decisions 11–15): permissions `purchase_prices.*`, `selling_prices.*`, `client_price_override.write`, `orders.price_override`, `instruments.*`, `invoices.*`, `ledger.reverse*`, `margins.read`, `cash.read`, `accounts.colour.read`, `due_items.read` and `ai.qa` change as listed there; migration 0024–0026 policies (purchase and selling prices, overrides) must be tightened.

## Legal
30. 🟡 Law 69-21 deadline alerts in MVP; full quarterly report in phase 2.
31. 🟡 Internal invoices only in MVP; official e-invoicing out of scope but data model ready (ICE etc.); possible phase-2 priority.

## Reasons behind key choices
- Light entry + AI assistance: Odoo failed because entry was heavy.
- Deterministic engine: money must be exact and auditable; AI can be wrong.
- Minimal Telegram: bot chats are not end-to-end encrypted.
- Morocco hosting: transfers abroad need CNDP authorization.
- Fake-data pilot: demo before any legal/security exposure.

## Open questions (verify before production)
1. Real revenue → which 69-21 and e-invoicing obligations apply (ask the accountant).
2. E-invoicing status and date for this company.
3. Real plant software name and export format. Partly answered: the software is ARCO GOLD TWO by Arco Electrónica (local partner ARCONOR Maroc). Its data export supports .xls, .pdf, .txt and .dbf for production, consumption and alarm history. Reports can be per formula, client, job, truck, driver and carrier. It logs manual and out-of-spec loads and dosing stops. Still open: a real export sample; the reconciliation spec will be updated once we have one.
4. CNDP: declaration + authorization for AI transfer; is pseudonymized data exempt? (assume no).
5. AI provider final choice after eval; contract terms and ZDR.
6. Real truck capacities, trip durations, zones.
7. VAT treatment and rates on concrete (not verified; keep configurable — pilot uses 20% as a parameter, see 66).
8. Moroccan hosting provider. The host must provide a reverse proxy that appends the client address to `X-Forwarded-For`; set `TRUSTED_PROXY_HOPS` to the number of such proxies. The app then counts only the entry the outermost trusted proxy appended; with `TRUSTED_PROXY_HOPS=0` (default) the header is ignored and only the per-account limit applies.
9. Opening balances: meetings with each person responsible for each type of number.
10. Partner's exact permissions. Provisionally answered for money by 81 (none); confirm with the owner on 2026-10-24.
11. Backup operations (CP5, also security checklist items): encrypted backups and their audit anchors are copied off the app host (where, how often, who checks the restore test); the age private key never lives on the app host; the `belgobeton_backup` role credentials (`DATABASE_URL_BACKUP`) exist only in the backup job's environment, never in the app runtime environment (the checklist computes this one).
12. Sign the backup audit anchor (CP6, deferred; also a pre-production checklist item, `backup_anchor_signed`): the anchor holds the SHA-256 of the backup and the last audit hash, unsigned, so anyone who can write both files can swap the backup and recompute the anchor. Sign it (age, minisign or ed25519) with a key held off the app host, or mirror the last hash to an independent store; decide with the hosting provider (8) and the backup operations (11).
