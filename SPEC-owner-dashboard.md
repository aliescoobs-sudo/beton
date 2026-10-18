# Spec: `owner-dashboard`

Status: DRAFT · Depends on: `rules-engine`, `reconciliation`, `notifications` · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
The brain's home (🟡 D19): in under a minute on his phone, the owner knows today's state, what is coming in the next 14 days, what is wrong, why, and what he can do. Works fully with AI switched off; AI text (brief, explanations) is an optional layer on top.

## 2. Screens (owner + partner; responsive PWA, fr + ar/RTL)

1. **Aujourd'hui** (home)
   - Cash: encaissé vs total incl. non encaissé; cheques in circulation (R9).
   - Forecast chart: 14 days, base + worst lines, safety threshold line, deficit days shaded; tap a day → flows of that day by certainty.
   - Alerts list: grouped `DAY-CONFLICT` first, then by severity (🔴 🟠 🟡 🔵) then target date; each with colour, "détecté le …", days ahead.
   - Today's deliveries and truck load (required vs capacity minutes).
   - Stock projection per component (days until shortage).
   - Yesterday's reconciliation status.
   - Daily brief (AI text if enabled, else template text from the same facts).
2. **Alert / black-day report**: target date; causes (each cause = linked document + amount + responsible person); timeline of the day; forecast before/after for each option; ranked options (max 3) with coverage %, counterparties, new risks; actions: "Préparer" (opens prefilled normal form), "Reclasser" (severity + reason), "Plus de détails" (AI Q&A if enabled), history.
3. **Comptes**: clients/suppliers list with colours (R14), filter by colour, balance and next échéance.
4. **Échéances**: due items next 14 days both directions; 69-21 and 71.24 deadlines.
5. **Rapprochement**: reconciliation runs and gaps (from `reconciliation`).
6. **Historique**: audit viewer.

Office home = task list (échéances to record, documents to enter) + entry screens; plant home = today's loads, import, count. Neither shows cash or forecast.

## 3. Behaviour
- All numbers come from the rules engine snapshot; UI formats only (`fr-MA` / `ar-MA` number format, MAD, m³).
- Data freshness shown ("calculé à 10:05"); the page refreshes on new alerts (server push via notification poll ≤ 30 s, 🟡).
- Sim badge always visible in simulated mode.
- Accessibility: WCAG 2.2 AA; colours always paired with an icon + text label (colour-blind safe); severity emoji are not the only signal.

## 4. Acceptance criteria
- **AC-DASH-01** With all AI kill switches off, every screen renders complete information, including the black-day report with causes and ranked options.
- **AC-DASH-02** At sim D3 10:05 the home shows the D5 `DAY-CONFLICT` on top with "détecté il y a ≥ 2 jours avant échéance" and the report shows the exact numbers of SPEC-simulation §4.
- **AC-DASH-03** Selecting an option shows the what-if forecast; nothing is written until the owner confirms the prefilled form (audit shows no write).
- **AC-DASH-04** Office and plant users get 404 on dashboard routes and see no cash figure anywhere (e2e scan of their pages).
- **AC-DASH-05** Home loads in < 2 s (LCP) on a mid-range phone profile with the sim dataset; layout works at 360 px width, in RTL.
- **AC-DASH-06** Each displayed amount equals the engine value (e2e compares DOM values with the engine snapshot API).
- **AC-DASH-07** Axe accessibility check: no serious/critical violations on the 6 screens in both locales.

## 5. Assumptions relied on
🟡 D19 (dashboard as home), 🟡 D21/D22 (colours/severities), 🟡 D41 (PWA), 🟡 D48 (languages), refresh interval 🟡.
