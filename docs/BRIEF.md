# BRIEF.md — KAYAS

## 1. One-line summary
KAYAS is a secure, AI-assisted "operations brain" for a mid-sized ready-mix concrete company in Tetouan, Morocco. It tracks every financial and material movement (orders, deliveries, stock, payments, cheques, installments, purchases, trucks), forecasts cash and stock problems **before** they happen, and talks with the owner until each problem is resolved.

## 2. Context
- Client: one concrete (béton prêt à l'emploi) company in Tetouan. Not a SaaS product (for now).
- Assumed size (pilot): ~20M MAD/year revenue, ~25,000 m³/year (~100 m³ per working day), 5 truck mixers, ~60 active clients, ~8 suppliers.
- History: used Odoo, abandoned it 2+ years ago. Main reasons: heavy data entry, and double work (plant operator computed in the plant software, then re-typed into Odoo). The process kept breaking down.
- Today: no management software. Office data lives in files; the plant has its own Excel-like batching/recipe software that only computes quantities (no prices).

## 3. The real problem
The owner is overloaded and often absent. When he is not watching, the system silently breaks:
- A delivery is missed → the client's site crew sits idle → lost client or contractual penalty → nobody can prove who is responsible (transport blames the plant, production blames stock, the plant operator blames weighing, the books say stock was available).
- Cash crunches are discovered on the day: e.g. a large cheque due in 2 days + not enough stock for a big delivery that day + that delivery is paid in installments + supplier purchases due the same day = a "black day" with only bad options.

When the owner is present, he fixes things through relationships. The goal is to give the company that awareness **without** depending on his presence.

## 4. Vision
The app is the "small world" a brain lives in. The brain:
- records every movement with who/when/what (traceability),
- knows today's state (cash, receivables, payables, cheques, stock, trucks),
- projects the coming days from scheduled orders, installments and cheques,
- classifies conflicts (risk / urgent / important / probable),
- alerts early (≥ 2 days ahead), explains causes, proposes solutions,
- converses with the owner (more details, reclassify "risk → important" once solved, or execute a command after confirmation).

## 5. Users and roles
| Role | Who | Main jobs |
|---|---|---|
| Owner | Company owner | Sees everything, receives alerts, answers the agent, decides |
| Partner | Minority partner | Same visibility as owner (configurable); also brings orders |
| Office staff (×2) | Data entry | Enter orders, payments, purchases, invoices — not stock movements |
| Plant operator | At the batching plant | Enters/imports what actually left the plant; daily physical count |

Orders come from the owner and partner: they tell the office (shipment details) and the plant (type, quantity, day).

## 6. Success criteria (pilot)
1. The owner watches a simulated week and sees a crisis he has lived (the black day) detected 2 days ahead, with a clear report and 2–3 ranked solutions, and says "this is what I need".
2. Entering an order takes under ~1 minute with AI-assisted entry.
3. End-of-day reconciliation (our planned data ↔ plant data ↔ physical count) shows any gap and where it most likely comes from.
4. Every change is traceable to a person and a time.

## 7. Non-negotiable constraints
- **Security and privacy first** in every phase (principle #0). Sensitive financial and personal data.
- **Data entry must be light**, or it will be abandoned like Odoo.
- **Numbers are computed by deterministic code**, never by the AI.
- **No AI action without human confirmation.**
- Compliance: Moroccan law 09-08 (CNDP), law 69-21 (payment deadlines), law 71.24 (cheques).

## 8. MVP (the pilot)
In scope:
- Master data: clients, suppliers, concrete types and recipes (mix designs), component purchase prices (various units), selling prices per m³, trucks, delivery zones.
- Orders with delivery date and payment plan (cash, cheque, LCN, transfer, advance, installments).
- Deliveries (loads) linked to orders.
- Payment instruments with full lifecycle (received → deposited → cleared / bounced → 30-day regularization window).
- Purchases and supplier payments.
- Stock: automatic deduction from recipes on each delivery; increase on purchases/receipts.
- Cash position + day-by-day cash forecast + risk engine + statuses and colors.
- AI (5 roles): assisted entry, daily brief, risk reports, owner Q&A (read-only), anomaly explanations in reconciliation.
- Alerts: minimal Telegram notification (no sensitive data) + in-app alerts and push.
- Daily reconciliation: plant import (Excel/CSV) or manual totals + physical count.
- Simple truck capacity check (trips per day vs planned loads).
- Basic alert on invoice payment deadlines (law 69-21).
- Security: RBAC, 2FA, immutable audit log, encryption, encrypted backups.
- Simulated company dataset + simulation clock (advance days) for the demo.

Out of scope (later):
- GPS / precise routing, WhatsApp, official e-invoicing (DGI), direct database/API integration with the plant software, client portal, native mobile app, multi-plant, payroll/HR, full accounting and tax filings, full 69-21 quarterly report, cheque OCR, storing national ID (CIN) numbers.

## 9. Platform (preliminary)
Responsive web app (PWA) for desktop and phone + Telegram bot for minimal alerts. Details in DECISIONS.md.
