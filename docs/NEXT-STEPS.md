# NEXT-STEPS.md — KAYAS

## 0. Prepare the folder
```bash
mkdir -p ~/belgobeton/docs
cd ~/belgobeton
# put BRIEF.md, RESEARCH.md, DECISIONS.md, DOMAIN.md, NEXT-STEPS.md in ~/belgobeton/docs/
git init
```

## 1. Create CLAUDE.md (project rules Claude Code reads every session)
Create `~/belgobeton/CLAUDE.md` with:
```markdown
# KAYAS — project rules
- Read docs/BRIEF.md, docs/DECISIONS.md and docs/DOMAIN.md before any work.
- Principle #0: security and privacy first. Never weaken RBAC, 2FA, audit log or encryption.
- Money is computed by deterministic code only, stored as integer centimes. AI never computes amounts.
- No hard deletes of financial records; corrections are reversing entries.
- No AI action without human confirmation. Pseudonymize data before any AI call.
- Pilot uses fake data only. Never commit secrets; use environment variables.
- Business vocabulary follows docs/DOMAIN.md (m³, recette, LCN, échéance...).
```

## 2. Start Claude Code
```bash
cd ~/belgobeton
claude
```

## 3. Write the spec
```
/agent-skills:spec Build the spec for KAYAS from docs/BRIEF.md, docs/DECISIONS.md, docs/DOMAIN.md and docs/RESEARCH.md. Scope = MVP pilot only (section 8 of BRIEF). Include: data model, roles and permissions (RBAC), rules engine (cash forecast, risk detection, reconciliation), AI layer with pseudonymization and confirmation flow, Telegram minimal alerts, simulation dataset and simulation clock for the "black day" scenario, security requirements, and acceptance criteria for each feature. Flag every 🟡 assumption you rely on.
```
Review the spec. Correct anything wrong before continuing.

## 4. Plan
```
/plan
```
(If your plugin namespaces commands, use `/agent-skills:plan`.)
Ask for small, testable tasks, with security and the rules engine first, UI and AI after.

## 5. Build
```
/build
```
(Or `/agent-skills:build`.) Build task by task; run tests after each task.

## Suggested build order
1. Project setup, auth with 2FA, RBAC, audit log.
2. Data model + master data (clients, suppliers, recipes, prices, trucks, zones).
3. Orders, deliveries, stock deduction.
4. Payments and instrument lifecycle; purchases.
5. Rules engine: cash forecast, statuses, alerts, reconciliation.
6. Simulation dataset + simulation clock + black-day scenario.
7. Dashboard (owner) + office entry screens + plant import screen.
8. AI layer: assisted entry, daily brief, risk report, Q&A (with pseudonymization).
9. Telegram minimal alerts + in-app push.
10. Security checklist review.

## Before production (not for the pilot)
- Accountant: real revenue, 69-21 obligations, e-invoicing status, VAT.
- Real plant software export sample.
- CNDP declaration + authorization (AI transfer).
- AI eval (~50 Darija/French examples) → final provider; request ZDR.
- Moroccan hosting provider.
- Opening-balance meetings with each responsible person.

## T19 follow-up (15 Nov 2026): what comes next for the 1 Dec go-live
- **T19b** (D246): the historical posting path for Jan-Nov (source = historical_import, batch id) and the importer kinds for Ventes, Encaissements, Achats, Paiements, Charges; cash count with variance; bank reconciliation; monthly close and lock; daily checklist; monthly owner table.
- **Finish T19 partials** (see docs/reviews/T19-REPORT.md): per-invoice aging and loans/leasing/opening stock in the opening importer; the order form showing that a client requires its PO and searching by alias; HT/TTC basis in the ledger; owner approvals-inbox entry for outgoing payments above the upper limit; charges feeding the finance entries.
- **Owner decisions on Monday 16 Nov**: the two payment-control limits (1 000 and 5 000 MAD, parameters on the settings screen); whether a private individual's building-site address counts as a "personal address" (D249 scan exception).
- **T20** (D251): the fictitious realistic twin seed.
- **Final audit**: every row of docs/SECURITY-DEBT.md dated 2026-11-15 under T19; run the data-scope scan and the office-money-read tests again.
