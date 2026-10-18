# Spec: `simulation`

Status: DRAFT · Depends on: `rules-engine`, `reconciliation`, `clock` · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
A believable fake company and a scripted week in which the owner relives a "black day" and sees the system detect it 2 days ahead with causes and ranked options (S1, 🟡 D19). Same seed ⇒ same company, same week, same alerts — so the demo and the e2e test are the same thing.

## 2. Scope
In: deterministic dataset generator, black-day script (scheduled events), demo controls (start, advance, reset), simulation-only guards.
Out: random "live" simulation, multiple scenarios (one scenario in MVP; format allows more later).

## 3. Dataset (fake only, 🟡 D37, 🟡 D49)
Generated from `fixtures/simulation/seed.ts` with a fixed seed. Names are obviously fictional (generated Moroccan-style names + "SARL Fictive"), phones `+212 600-000-xxx`, ICE `000000000000xxx`.

| Entity | Count / values |
|---|---|
| Users | owner, partner, office ×2, plant ×1 (demo TOTP secrets in `.env.sim`, never real) |
| Clients | 60 (40 companies, 20 persons), sites across the 5 zones |
| Suppliers | 8: FRN-01 cement, FRN-02 sand, FRN-03 gravel, FRN-04 admixture, FRN-05 transport, FRN-06 fuel, FRN-07 aggregates 2, FRN-08 other |
| Concrete types | B20, B25, B30 (+ recettes, cement 300 / 350 / 400 kg/m³) |
| Components | cement, sand, gravel 8/15, gravel 15/25, water, admixture |
| Trucks | T1–T5, 8 m³ |
| Zones | per 🟡 D53 |
| Prices | B20 700, B25 780, B30 860 MAD HT/m³; cement 1 450 MAD/t HT (fake) |
| History | 8 weeks of orders/deliveries/payments (~100 m³/working day) so colours, receivables and post-dated cheques in hand look real |
| Opening (D1 07:00) | bank 310 000,00 + caisse 18 000,00 = encaisse 328 000,00 MAD |

## 4. The black-day week
Sim week: D1 = Mon 23 Nov 2026 … D6 = Sat 28 Nov 2026 (avoids 6 & 18 Nov holidays). Black day **D5 = Fri 27 Nov 2026**. Fixture constraint: routine flows D1–D5 net +175 000,00 MAD and realize as planned; base balance stays ≥ 0 on every other horizon day.

| When (sim) | Event | Expected system reaction |
|---|---|---|
| Before D1 | Outgoing post-dated cheque to FRN-01 (cement) 520 000,00, issued D−20, written D5. Transport payable FRN-05 85 000,00 by transfer due D5 (no instrument issued). Incoming cheque CLT-08 150 000,00 deposited D2 (expected to clear D3). Post-dated cheques in hand: CLT-03 60 000,00 (written D8), CLT-22 45 000,00 (D9), CLT-31 30 000,00 (D11) | — |
| D1 07:00 | Brief | Base D5 = 48 000,00 (≥ 0). Worst case (FRN-01 cheque presented today) < 0 ⇒ 🟠 `CASH-DEFICIT-WORST` |
| D2 11:00 | Partner brings order CLT-17: 120 m³ B25, site Fnideq, D5, 780 MAD HT/m³, plan 20% cash at delivery D5 / 40% D+30 / 40% D+60 | Base D5 = 70 464,00. Cement projected D5: available 41 t vs need 66 t (42 t CLT-17 + 24 t routine 80 m³) ⇒ 🔴 `STOCK-SHORTAGE` 25 t (3 days ahead) |
| D2 20:00 | Day close: plant import B20 82 m³ vs BL 80 m³; cement count −3.1% | 🔴 `RECON-GAP` with attribution (SPEC-reconciliation AC-REC-03/04) |
| D3 07:00 | Due reminders | 🟠 `PAY-DUE` FRN-01 cheque and FRN-05 transfer (due ≤ 2 days) |
| D3 09:00 | Plant logs T3 breakdown D4–D6 | D5 capacity 2 400 min < required 2 850 min ⇒ 🔴 `TRUCK-OVERCAPACITY` |
| D3 10:00 | Bank reports CLT-08 cheque 150 000,00 bounced | 🔴 `CHQ-BOUNCED` (window → D3+30); base D5 = **−79 536,00** ⇒ 🔴 `CASH-DEFICIT`; 🔴 `DAY-CONFLICT` D5 groups cash + stock + trucks + bounce + payables |
| D3 10:05 | Black-day report ready | Combined shortfall with emergency cement (25 t × 1 450 HT + 20% VAT = 43 500,00) = **123 036,00**; options: 1) `DEPOSIT-EARLY` CLT-03/22/31 135 000,00 (full); 2) `POSTPONE-PAYABLE` FRN-05 → D9 + `REQUEST-ADVANCE` CLT-17 20%→50% (+33 696,00) = 118 696,00 (96.5%); 3) `POSTPONE-PAYABLE` FRN-05 alone (69.1%). Telegram ping + in-app alert |
| D3 (owner) | Owner reviews, chooses option 1, opens prefilled deposit form, confirms; reclassifies cash alert 🔴 → 🟡 "dépôt anticipé fait" | Forecast D5 ≥ 0; alert 🟡; audit shows owner actions |
| D4–D6 | Routine; emergency cement purchase received D4; CLT-17 delivered D5 split per owner choice | Alerts auto-resolve; D5 reconciliation runs |

Simulation parameters: `vat_rate_bp` = 2000, `clearing_delay_days` = 1 — set in the fixture, not in code. All numbers in this table are asserted by `e2e/black-day.spec.ts` and `fixtures/simulation/black-day.int.test.ts`; if a parameter (VAT, clearing delay) changes, the fixture is re-tuned and this table updated (ask first).

## 5. Demo controls (owner only, pilot only)
Top bar: sim date badge, "▶ Avancer à" (next event / next day 07:00 / next day 20:00), "Réinitialiser la démo". Advancing uses `clock.advance` (step-up 2FA, audited). Scripted events are applied by the clock as ordinary service calls with the scripted actor (e.g. "plant" user), so they go through RBAC, audit and the rules engine like real entries.

Reset (🟡 A21): drops and recreates the **simulation database** and re-seeds; allowed only when `SIMULATION_ENABLED=true`; the only exception to "no hard deletes", and only for fake data.

## 6. Acceptance criteria
- **AC-SIM-01** `pnpm db:seed:sim` twice with the same seed produces identical data (hash of a canonical export).
- **AC-SIM-02** Seed and reset refuse to run when `SIMULATION_ENABLED` ≠ `true`, `NODE_ENV=production`, or `REAL_DATA=true`.
- **AC-SIM-03** Every event in §4 produces the expected reaction at the stated sim time (integration test per row).
- **AC-SIM-04** At sim time D3 07:00 or earlier, at least one 🔴 alert targets D5 (`STOCK-SHORTAGE` from D2); by D3 10:05 the `DAY-CONFLICT` for D5 exists with `first_detected_at` ≤ D3 — i.e. ≥ 2 days ahead (S1).
- **AC-SIM-05** The black-day report numbers match §4 exactly.
- **AC-SIM-06** Scripted events appear in the audit log under the scripted user, with sim_at.
- **AC-SIM-07** No real personal data in fixtures: a lint script checks fixtures against patterns (real-looking phone ranges, 15-digit ICE not starting with `000000000`).
- **AC-SIM-08** Full demo (D1 → D6) runs end-to-end in Playwright in < 5 min, in both `fr` and `ar`.

## 7. Assumptions relied on
🟡 D19 (black-day scene), 🟡 D37 (fake data), 🟡 D44 (sim clock), 🟡 D49 (company size), 🟡 D53 (zones), ✅ A4 (VAT 20%, parameter), ✅ A17 (1-working-day clearing, parameter), 🟡 A18, 🟡 A21. All amounts and prices are fictional.
