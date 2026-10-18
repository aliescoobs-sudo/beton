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
29. 🟡 Rule: post-dated cheques may be presented early (worst case treated as risk).
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
33. 🟡 RBAC: owner/partner see all; office sees only their transactions (no margins, no global cash); plant sees production and stock only.
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
43. 🟡 Preliminary stack: TypeScript full-stack (Next.js) + PostgreSQL with Row-Level Security + scheduled jobs + Telegram bot + swappable AI layer. Final choice in spec.
44. 🟡 Simulation clock in pilot.
45. 🟡 Trucks in MVP: list + warning when planned loads exceed daily trip capacity.
48. 🟡 UI languages: Arabic/Darija + French (financial terms in French as used in the office).
50. 🟡 AI: Claude Haiku 5.5 (light tasks) + Sonnet 5.5 (analysis); Mistral as comparison; final pick after a ~50-example Darija/French eval.
53. 🟡 Simulation zones (one way): Tetouan center 20 min, Martil 25, M'diq 30, Fnideq 45, Oued Laou 60; + 30 min unloading.
32. 🟡 Configurable parameters: 90-min concrete limit, 30-min unloading, capacity per truck (default 8 m³).

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
3. Real plant software name and export format.
4. CNDP: declaration + authorization for AI transfer; is pseudonymized data exempt? (assume no).
5. AI provider final choice after eval; contract terms and ZDR.
6. Real truck capacities, trip durations, zones.
7. VAT treatment and rates on concrete (not verified; keep configurable).
8. Moroccan hosting provider.
9. Opening balances: meetings with each person responsible for each type of number.
10. Partner's exact permissions.
