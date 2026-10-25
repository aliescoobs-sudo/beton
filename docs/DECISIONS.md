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
79. ✅ (CP-M1) Migrations create structure only (one exception, 2026-10-25: a migration that changes the shape of a table may convert the rows that already exist, derived from rows the application wrote, as the system actor so the audit records them: 0053 and 0055, listed in scripts/migrations-structure-only.test.ts). Fake data, including reference values that are still assumptions (e.g. zones and their times, 🟡 D53), comes only from the pilot seed, which refuses to run with `REAL_DATA=true`.
80. ✅ (T10–T15 review) The pilot seed has its own login role, `belgobeton_seed` (`DATABASE_URL_SEED`, in `.env.ops`). `db:bootstrap` creates it only with `SIMULATION_ENABLED=true` and neither `REAL_DATA` nor production, and switches an existing one to NOLOGIN otherwise. Its grants (SELECT/INSERT on master data, the code counter, `audit.record`) are in `db/seed/seed-role.sql`, applied after the migrations only where the role can log in. `belgobeton_system` never inserts master data, bumps counters or reads prices (migration 0029); the table-access meta-test enforces both.

## Money visibility (2026-10-23, provisional, to be confirmed by the owner on 2026-10-24)
81. 🟡 **Money visibility.** Money data = balances, totals, forecasts, client and supplier balances, payment instruments, invoice amounts, prices (selling, purchase, overrides, order and purchase totals, plan items, cost and margin). It is enforced in the database (RLS policies and column grants keyed on the request role, D76), not only in the UI; every money table and view has a test proving the roles below get zero rows.
    - **owner**: reads and writes all money data; the only role that confirms, approves or posts a money action (confirmations, corrections, price changes, overrides).
    - **support** (new role, the technical companion): reads all money data, and every other table; read-only everywhere; can never confirm, approve or post a money action (no INSERT/UPDATE grant path, no permission in the write lists); 2FA mandatory (D35); every session and every view of a money screen is audited; the owner can disable the account at any time (`users.manage`). Money views are audited by the app (a database cannot log plain reads): every money read goes through one service that records the view event first.
    - **office**: blind entry. Can create invoices, payments received, cheques/LCN received and expenses; after saving it cannot read them back: no lists with amounts, no balances, no totals, no forecast, no prices. Writing a row never returns an amount. A correction is a request to the owner (a record with the document code and a reason, no amount); office cannot reverse.
    - **plant**: stock, deliveries in m³ and recettes only; no price, no money. Unchanged.
    - **partner**: no money access for now, until the owner decides. Keeps operational (non-money) rights: trucks, zones, components, recettes, concrete types, clients and suppliers without balances, reconciliation.
    Supersedes in part: 33, 60, 67 (and the "Partner's exact permissions" open question for money). Consequences recorded in tasks/plan-ledger.md (Decisions 11–15): permissions `purchase_prices.*`, `selling_prices.*`, `client_price_override.write`, `orders.price_override`, `instruments.*`, `invoices.*`, `ledger.reverse*`, `margins.read`, `cash.read`, `accounts.colour.read`, `due_items.read` and `ai.qa` change as listed there; migration 0024–0026 policies (purchase and selling prices, overrides) must be tightened.
82. 🟡 **Statements, documents and exports** (owner's brief 2026-10-24, provisional). Client and supplier account statements, invoices, credit notes and quotes (as PDF), and the accountant export are money documents: read, printed and downloaded by the owner and support only, every view, print, download and export audited (`view` / `export`). Office creates invoices, quotes and purchases blind and cannot print or read them; partner has none. The delivery note (BL) carries no price and is printed by office and plant (and owner, partner, support). Statements keep the commercial side (ordered, delivered, invoiced, credit notes) apart from the financial side (payments, cash, cheques, LCN, transfers, advances). Export format: CSV in the MVP; the accountant may ask for another (open question 13). Supersedes nothing; extends 81.

## Review of CP-L4 and CP-OPS-1-3 (2026-10-25)
83. 🟡 (provisional, to confirm with the owner) **Delivery note.** The plant may see and print the client's name and the site on the BL, because the client signs it. No contact, no price, no total, no payment. This changes 81 for the plant on this one document: the plant still reads no client table and no money (`delivery_note()` returns names, places and quantities only). Supersedes the "client code only" line of 81 for the BL.
84. ✅ (review of CP-L4, point 1) **No office door to a price.** An office-context call never receives a price, a total, a client or a load: invoices, orders and quotes are created entirely inside the database (`create_invoice`, `create_order`, `create_quote`) and return the document code only; office has no INSERT policy on the document tables; `resolve_selling_price` answers the owner and the system; the price checks of the guard triggers run after row-level security. `create_invoice` audits every failure and locks an actor out after ten in ten minutes.
85. 🟡 **Payment state of an invoice** is derived, never stored: the covered plan items of the order pay its live invoices, oldest first; paid, partially paid or unpaid. Owner and support only (shown on invoices, statements and the dashboard).
86. 🟡 **Partial receipts.** A purchase can be received in several parts until each line reaches its ordered quantity, each part adding its stock. More than ordered is an over-receipt: only the owner records it, with a confirmation, and it is flagged on the receipt.
87. 🟡 **Loads above the order volume** are allowed (the plant is never blocked), warned about, recorded by the database as an excess and confirmed by the owner (step-up); billed at the order's price like any load. Tolerance parameter `load_excess_tolerance_bp` (500 = 5 % of the order, default 🟡) tells a minor excess from a major one.
88. ✅ **One threshold source.** `stock_threshold` (versioned, audited, owner and partner write) is the only low-stock threshold; the old `component.low_stock_threshold` values were copied into it and the column dropped.
89. 🟡 **Rules engine defaults** (all parameters, ask before changing): 14 working days, safety threshold 0, due alerts 2 days ahead, legal reminders 7 days, bounce reminders at day 20 and 27, purchase lead 2 days, LCN discount 8 % a year, postponement 4 working days, advance 30 % of the order, split 50 %. Overdue receivables are not in the forecast (not counted until paid); an LCN is discounted, a cheque deposited early (D29).
90. 🟡 **Confirming an option** (`cash.decide`, step-up `cash.apply_option`) records a decision with the figures the engine computed; only the early deposit moves anything (the ledger's own deposit, same transaction). Discount, postponement, advance, split and purchase are decisions with a draft message the owner sends himself. The nightly recompute is not wired: the system role has no read path to money tables.

## Operations second wave (2026-10-25, owner's change of priority)
91. 🟡 **Dispatch.** Each order of the day is cut into rotations of at most a truck's capacity; the proposal takes the truck free first and pairs drivers to the available trucks in code order (a fixed driver per truck is an open question). A truck marked broken in the log cannot be planned (service and database); the other conflicts are shown, not blocking. A person saves the plan; replanning cancels the earlier rotations with a reason, except those already started. From the business day on, orders overdue in the last two weeks and still to load are planned with the day's. Office does not see the dispatch (blind to orders).
92. 🟡 **Trip tracking** has six steps; the first, `loaded`, is the existing load (BL, stock down) so a rotation is tied to its BL. Times are the clock's (real or simulated), waiting time on site and the other figures are derived. Times shown to the user are formatted on the server (the browser's time-zone data may differ from Node's).
93. 🟡 **Consumption report.** Theoretical consumption is what the loads wrote (the recette in force on each load date); actual consumption comes from the count adjustments of the period (a count counts in the period it is entered, and measures everything since the previous count); no count, no actual figure. Flag above `consumption_tolerance_bp` (200 = 2 %, R20). Lost concrete (rejected or brought back) stays inside production and consumption and has its own lines; it does not give components back and does not change billing (a credit is the owner's credit note).
94. 🟡 **Reorder suggestion.** Days of cover = calendar days until the stock under the open orders reaches zero. A draft purchase is suggested when the cover is shorter than the supplier's lead time (`supplier.lead_time_days`, else `purchase_lead_days`) plus `reorder_margin_days`. It is a draft for the owner: nothing is ordered; plant and partner see the cover and the order-by date but no supplier, price or draft (the supplier hint reads money tables).
95. 🟡 **Fuel.** Fills are quantities (plant, owner, partner); fuel purchases are a money table (owner writes, owner and support read). The cost of a truck's fuel is Σ purchases × the truck's litres ÷ Σ litres (one rounding); a station fill is valued like any other litre at that average. The answer for plant and partner has no money key at all.
96. 🟡 **Sales volume analytics.** m³ per day, week and month by client, concrete type and zone, cancellations on the day of their load; the amount (m³ × the order's unit price, HT, one rounding per load) is computed apart and given to owner and support only; the partner reads the quantities, plant and office have no page.

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
13. Money documents: confirm with the owner who may print or send invoices, credit notes and quotes (provisional 82: owner and support only), the format the accountant wants (CSV, XLSX, a journal layout), and the company's legal mentions (ICE, IF, RC, taxe professionnelle/patente, address, RIB; fake in the pilot). The accountant confirms the full list of mandatory mentions on an invoice; every identity field stays editable by the owner in the company profile.
