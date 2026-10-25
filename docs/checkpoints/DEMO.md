# Demo: what is ready to show, and where

Updated 2026-10-25 (rules engine, owner dashboard and the operations second wave added: dispatch, trip tracking, consumption, cover, fuel, refused loads, sales volumes; the demo itself is postponed). Everything below is on the **dev database**, fake data only (the amber band
says so). It was prepared tonight: all migrations applied (63), `db:seed` re-run, `db:scenario` run (it now also seeds the operations second wave), the audit
chain verified (9 364 events), the single user and its 2FA untouched. A fresh `pnpm dev` is running on http://127.0.0.1:3000 (if it is not,
stop any old one and run `pnpm dev` again: the stale-server problem was a server started before the last migrations).

**Sign in** at `/fr/login` with your owner account and authenticator. `/ar/…` is the same site in Arabic (right-to-left).
**The simulated clock is on 1 November 2026, 07:00** (a Sunday): the data is dated around it (opening 1 August, about three
months of activity). Move the clock with the day strip under the menu if you want another day.

## What the data holds
25 clients, 8 suppliers, 99 orders, ~205 payments in every state (cheques and LCN in portfolio, deposited, cleared, bounced
inside the 30-day window, regularized, disputed), 630 truck loads with their delivery notes (570 signed notes back), 82
purchases (72 received into the stock, others still expected), 85 invoices and one credit note, opening stock, stock below
its threshold for cement, our fake legal identity, 3 orders waiting to be loaded.
**Operations second wave** (same dev data): 5 drivers; 84 rotations of the last two weeks, planned and tracked (loaded,
departed, arrived, waiting on site, unloading, back; some waits are long), today's still on the road, a plan saved for today
and the next days; 24 weekly stock counts (the sand regularly above the 2 % tolerance, cement within it) and one big gap on
the 15/25 gravel; 32 fuel fills with the odometer and 3 fuel purchases; 5 refused or brought-back loads; supplier lead
times (cement 3 days, aggregates 2, admixture 4). The 15/25 gravel is now short in two days: the cover screen suggests a
reorder.

## Screens ready, with their path (menu group in brackets)
| Screen | Path | What to show |
|---|---|---|
| Aujourd'hui (owner, support) | `/fr` | the brief, cash (encaissé / total / cheques to debit), the **14-day forecast chart** (cash above the line, deficit hatched below it, worst case dashed, flows listed under each day, 7 or 14 days), the **black day** and its causes, the alerts by severity with "détecté N jours avant", stock of the next days, loads, late clients (not counted), decisions taken |
| Rapport d'alerte | `/fr/alerts/<key>` (click an alert) | causes, **ranked options** with computed coverage, what-if forecast before / after, "Préparer" then "Confirmer" (fresh 2FA), the draft message to copy, "Reclasser" with a reason |
| Projection du stock | `/fr/stock/projection` (Production) | per component, day by day: orders' needs by the recette in force, receipts expected, level; quantities only |
| Planning du jour | `/fr/dispatch?date=2026-11-01` (Production) | the day's orders (the overdue ones to load with a "en retard" tag), the **proposal**: rotations per truck capacity with truck, driver and times (07:00 load, drive, unload, back), a timeline per truck, conflicts (broken truck blocks, driver or truck twice, past the working day, long trip), edit a truck or driver and see the conflicts move, "Enregistrer le plan"; drivers at the bottom |
| Suivi des rotations | `/fr/trips?date=…` (Production) | **phone-sized**: one card per rotation, one big button for the next step (Charger (BL) → Parti → Arrivé → Début → Fin du déchargement → De retour), the time of each step, waiting time on site, unloading, round trip, concrete age, delay; try it at 375 px |
| Production et consommation | `/fr/reports/consumption` (Production) | m³ per type and period, theoretical consumption per component against the counts, variance flagged above the tolerance (sand), the lost concrete lines; plant and partner read it |
| Couverture et réapprovisionnement | `/fr/stock/projection` (Production) | days of cover per component, supplier lead time (from the supplier sheet or the parameter), "à commander avant le…", and for the owner a **draft purchase** (supplier, quantity, estimate): nothing is ordered |
| Carburant | `/fr/fuel` (Production) | fills per truck with the odometer, litres per 100 km and per m³, and for the owner the average price and the cost per m³; add a fill (plant) or a purchase (owner) |
| Volumes vendus | `/fr/analytics` (Ventes) | m³ per day, week or month by type, client or zone, with the amount HT for the owner; the partner sees the m³ only |
| Béton perdu | `/fr/loads` (Production) | on each load, "Béton refusé ou rapporté": reason and m³, once; counted in the consumption report |
| Aujourd'hui (office, plant, partner) | `/fr` | no money at all: loads to make and stock alerts |
| Clients, suppliers, prices, recettes, trucks, zones, components | `/fr/master-data/…` (Données de base, Ventes, Achats, Production) | master data with archive and price history |
| Devis | `/fr/quotes`, `/fr/quotes/new` (Ventes) | a quote at the price in force, printable, "Convertir en commande" opens the prefilled order form |
| Commandes | `/fr/orders`, detail `/fr/orders/<id>` (Ventes) | what is delivered / invoiced / paid, state of each échéance, cancel with a reason (step-up) |
| Nouvelle commande | `/fr/orders/new` (Ventes) | office-style entry; as owner: preview of the amounts and a price override with a reason; after saving, "ce que cette action a changé" |
| Facturer une commande, Factures | `/fr/invoices/new`, `/fr/invoices`, document `/fr/invoices/<id>` (Ventes, Trésorerie) | invoice by order code, ICE and VAT copied, law 69-21 term, print / PDF (print is audited), credit note |
| Saisir un paiement | `/fr/payments/new` (Ventes) | cash, cheque, LCN, transfer, covering an order or a purchase by its code |
| Paiements et titres | `/fr/instruments` (Trésorerie) | deposit batch, clear, bounce with the 30-day countdown, regularize, dispute |
| Caisse et banques, Position de trésorerie | `/fr/accounts`, `/fr/cash` (Trésorerie) | real cash vs total including uncleared |
| Comptes (relevés) | `/fr/statements` and `/fr/statements/client/<id>` (Trésorerie) | client and supplier statements, two sections, running balance, CSV export |
| Échéances légales | `/fr/deadlines` (Trésorerie) | invoices to issue by month end, to collect, purchases to pay |
| Export comptable | `/fr/accounting` (Trésorerie) | four CSV files for a period, refused if the journals do not tie out |
| État d'ouverture | `/fr/opening` (Trésorerie) | opening date and balances |
| Achats | `/fr/purchases`, `/fr/purchases/new` (Achats) | entry (stock lines and services), list with due dates, detail, cancel |
| Chargements | `/fr/loads` (Production) | orders to load, one tap to load (BL number, stock effect shown), delivery list, signed-BL return, delivery note `/fr/deliveries/<id>` with our mentions |
| Réceptions | `/fr/receipts` (Production) | goods expected and received, quantities only; "Réceptionner" adds to the stock |
| Stock | `/fr/stock` (Production) | levels against thresholds (cement is low), set a threshold |
| Entreprise | `/fr/company` (Administration) | our legal identity, versioned |
| Administration | `/fr/admin/users`, `/fr/parameters`, `/fr/checklist`, `/fr/historique`, `/fr/security` | users and 2FA, parameters, security checklist, audit viewer |

A good ten-minute path: Tableau de bord → Commandes (open one) → Planning du jour (the proposal, save it) → Suivi des rotations (tap through one rotation) → Chargements (load one of the 3
waiting orders, read the effects) → Stock → Facturer that order → Factures (open, Imprimer) → Saisir un paiement (a cheque for it) → Paiements et titres
(deposit, clear) → Position de trésorerie → Échéances légales → Export comptable. Then sign in as office or the plant (create
those users from `/fr/admin/users`; I created none) to show the blind entry and the plant's quantity-only screens.

## The black day on this data (clock on Sunday 1 November 2026)
The scenario already holds one tight day: a cement cheque of 679 200,00 MAD issued by us, written for Thursday 5 November,
against about 600 000,00 MAD in the accounts. Open Aujourd'hui: the forecast turns negative on the 5th (hatched bars), the
black-day box lists the cheque as the cause, the alert "Déficit de trésorerie le jeu. 05/11" is first in the list. Open it:
the options are ranked (discount of the LCN in portfolio, early deposit of the post-dated cheques in hand, postponing a
supplier payment…), each with its coverage, the forecast it would give and the counterparties. **Moving the clock with the day strip
also stores what the engine sees on the new day** (so are your visits to the page): that is the day an alert was first seen ("détecté 3 jours avant"). "Confirmer" on
the early deposit really deposits the cheques (choose the bank account) and records the decision; the discount, postponement,
advance and reminder options record the decision and give a draft message you copy and send yourself.
The dev database keeps whatever you confirm: advance the clock or ignore it, nothing is reset.

## Not ready, or to say out loud
- The daily brief is template text from the same facts (the AI layer is not built). No notifications yet.
- Not wired: the nightly recompute job (the system role cannot read money tables; a decision for you). Alerts are stored
  when the owner opens the page. Postponements and advances are recorded as decisions but do not move the forecast until the
  ledger records what really happened (plan items are insert-only, there is no reschedule service).
- Worst-case-only deficits (post-dated cheques presented early) show as an alert but offer no options yet.
- Truck over-capacity and the reconciliation gap alerts wait for their modules.
- Office can no longer enter an order, quote or invoice by direct insert: it goes through database functions that return
  only the number (security fix, docs/checkpoints/CP-RE-1.md). The dev server needs no restart; the database is migrated.
- Invoices print through the browser (Imprimer / save as PDF); there is no server-side PDF library yet (needs your approval of
  one). An invoice does not show "paid" by itself: payments cover the order's échéances.
- Not built: reconciliation with the plant software, notifications, the AI layer. (Stock counts and load cancellation have
  screens now: Stock and Chargements, owner only.)
- Drivers are paired to trucks in code order by the proposal; a fixed driver per truck is a question for you. Fuel filled at
  a station is valued at the average price of the fuel bought. Rejected concrete stays billed unless you issue a credit note.
- A stock count counts in the period it is entered and measures everything since the previous count.
- Times shown on the tracking screen are formatted on the server in Casablanca time.
- The partner role still sees no money (decision 81, provisional). The plant sees and prints the client's name and the site on the delivery note (decision 83, provisional).
- The demo data is dated on the simulated clock: if the clock is moved a long way, "late" and "due" change accordingly.
