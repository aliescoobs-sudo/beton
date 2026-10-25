# Demo: what is ready to show, and where

Written 2026-10-25 for the demo on this machine. Everything below is on the **dev database**, fake data only (the amber band
says so). It was prepared tonight: all migrations applied (51), `db:seed` re-run, `db:scenario` run, the audit chain verified
(8 547 events), the single user and its 2FA untouched. A fresh `pnpm dev` is running on http://127.0.0.1:3000 (if it is not,
stop any old one and run `pnpm dev` again: the stale-server problem was a server started before the last migrations).

**Sign in** at `/fr/login` with your owner account and authenticator. `/ar/…` is the same site in Arabic (right-to-left).
**The simulated clock is on 1 November 2026, 07:00** (a Sunday): the data is dated around it (opening 1 August, about three
months of activity). Move the clock with the day strip under the menu if you want another day.

## What the data holds
25 clients, 8 suppliers, 99 orders, ~205 payments in every state (cheques and LCN in portfolio, deposited, cleared, bounced
inside the 30-day window, regularized, disputed), 630 truck loads with their delivery notes (570 signed notes back), 82
purchases (72 received into the stock, others still expected), 85 invoices and one credit note, opening stock, stock below
its threshold for cement, our fake legal identity, 3 orders waiting to be loaded.

## Screens ready, with their path (menu group in brackets)
| Screen | Path | What to show |
|---|---|---|
| Tableau de bord ("Aujourd'hui") | `/fr` | cash (encaissé / total), late items, what to collect and pay, stock to watch, shortcuts to enter |
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

A good ten-minute path: Tableau de bord → Commandes (open one) → Chargements (load one of the 3 waiting orders, read the
effects) → Stock → Facturer that order → Factures (open, Imprimer) → Saisir un paiement (a cheque for it) → Paiements et titres
(deposit, clear) → Position de trésorerie → Échéances légales → Export comptable. Then sign in as office or the plant (create
those users from `/fr/admin/users`; I created none) to show the blind entry and the plant's quantity-only screens.

## Not ready, or to say out loud
- The home page is an interim "Aujourd'hui" built from the existing services; the forecast, black-day alerts and the daily
  brief belong to the rules-engine and owner-dashboard modules, which are not built.
- Invoices print through the browser (Imprimer / save as PDF); there is no server-side PDF library yet (needs your approval of
  one). An invoice does not show "paid" by itself: payments cover the order's échéances.
- Not built: reconciliation with the plant software, notifications, the AI layer, stock counts and load-cancellation screens.
- The partner role still sees no money (decision 81, provisional). The plant does not see the client's name on the delivery note.
- The demo data is dated on the simulated clock: if the clock is moved a long way, "late" and "due" change accordingly.
