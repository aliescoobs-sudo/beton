# Demo: what is ready to show, and where

Updated 2026-10-26 (the integration wave: documents flow without re-typing, from the rotation to the paid invoice and from the purchase order to the paid supplier invoice; the demo itself is postponed). Everything below is on the **dev database**, fake data only (the amber band
says so). Migrations applied: 75, `db:seed` re-run, `db:scenario` run (it now also walks the two chains below), the audit
chain verified (9 492 events), the single user and its 2FA untouched. If the dev server was started before the last migrations, stop it and run `pnpm dev` again.

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

**The integration walk** (new, same dev data; `db:scenario` is idempotent and adds it once):
- *Sales chain* for the client **Chantier Intégration (fictif)** (CLT-026): three orders (CMD-2026-00100 to 00102, 16, 8 and 8 m³). The 16 m³ one is planned in two rotations on 22 October: the first on its truck's **default driver**, the second **overridden with a reason**. Both are tracked to the end, so the unloading step **delivers** their BLs (BL-2026-00631, 00632); the other two BLs (00633, 00634) went out without a rotation and were marked delivered by hand. Signed BLs are back for two of the four. One **invoice from three BLs of two orders** (FA-2026-00087, with the 50 % **advance** applied: "Acompte reçu" 8 160,00, "Net à payer") and a second from the fourth BL (FA-2026-00088). A first cheque is **allocated oldest due first** (it clears the first invoice and puts 3 000,00 on the second), a second cheque for the rest **bounces**: its allocations are reversed, the second invoice is open again, the 30-day window to regularize runs to 30 November. The **client statement** shows all of it.
- *Purchase chain*: purchase order ACH-2026-00083 (30 units of cement), **partial receipt** (18 of 30), the supplier's invoice FS-DEMO-0001 (our code FF-2026-00001) for all 30 at 3 % above our price: the **match flags** the quantity beyond what was received and the price, the owner **accepts the gaps with a reason**, **approves** it (the payable is created from the invoice, not from the order), and a transfer **pays** it, allocated to the invoice.

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
| À facturer | `/fr/invoices/queue` (Ventes) | delivered BLs not yet invoiced, per client; tick some BLs, "Facturer" makes one invoice (grouped by product with the BL numbers, advance and net to pay); office sees BL numbers, dates, m³ and product, never an amount |
| Livraison et BL signé | `/fr/loads`, delivery note `/fr/deliveries/<id>` (Production) | "Marquer livré" for a load outside a rotation, "BL signé de retour" with an optional scan (photo or PDF, checked by type and content, stored encrypted, opened by an audited route) |
| Imputation d'un paiement | `/fr/instruments` (Trésorerie) | one action spreads a client's payment over the open invoices, oldest due first; the owner may override with a reason; a bounce reverses the allocations and reopens the invoices |
| Avoirs | `/fr/avoirs` (Trésorerie) | concrete refused or brought back after billing waits here; the owner issues the avoir (step-up) referencing invoice, BL and loss; support reads |
| Factures fournisseurs | `/fr/supplier-invoices`, `/fr/supplier-invoices/new` (Achats) | the supplier's invoice as its own document linked to the order and receipts; the three-way match with its flags; accept the gaps with a reason, approve (step-up) or reject; attach the photo; office enters blind |
| Chaîne de commande | `/fr/orders/chain` (Ventes) | one row per order: ordered, planned, loaded, delivered, invoiced, paid; every role sees quantities and stages, only owner and support see "paid", nobody an amount |
| Documents liés et recherche | the panel under each document, the search box in the top bar (`/fr/search`) | neighbours by number, filtered by the caller's rights; search by document number only (4 characters at least), misses audited |
| PDF | "Télécharger le PDF" on a BL, invoice, quote, avoir, statement | server-generated, never stored, legal mentions, "SPÉCIMEN — données fictives" on every page, each download audited; the BL PDF has no price |
| Où est mon camion (office) | `/fr/dispatch/office` (Production) | office's read-only day: truck, times, m³, client name, step reached, BL number; no price, no order |
| Chauffeur par défaut | `/fr/dispatch` (bottom of the page) | each truck's default driver; the proposal uses it; another driver on a rotation asks for a reason; overdue orders are flagged by a red edge and the text "en retard depuis le…" |
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

**The integration path (ten minutes):** Chaîne de commande (find CMD-2026-00100) → open the order, "Documents liés" → the BL → "Télécharger le PDF" (no price) → À facturer (the client has nothing left to invoice; the walk did it) → Factures: FA-2026-00087 (grouped lines, "Acompte reçu", "Net à payer", PDF) → Comptes: the client statement (invoices, cleared cheque, **bounced cheque**) → Paiements et titres (the bounce and its window) → Planning du jour on 22 October (default driver, the override and its reason) → Factures fournisseurs: FF-2026-00001 (the match, the accepted gaps, approved, paid). Then sign in as office: "Où est mon camion", À facturer without amounts, the order chain without "paid".

A good ten-minute path (the original one): Tableau de bord → Commandes (open one) → Planning du jour (the proposal, save it) → Suivi des rotations (tap through one rotation) → Chargements (load one of the 3
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

## The assistant, one walk per role (scripted provider, no network)
Switch it on for the demo only: in `.env.local` put `ASSISTANT_ENABLED=true` (`ASSISTANT_PROVIDER` stays `fake`, the default), restart the
dev server. The application refuses to start with the flag on next to real data or in production. Then `corepack pnpm db:scenario`
plays the morning of each role through the application's own door, as that person, with the Fake provider (the demo accounts of the
office and the plant are created if missing, with a random password nobody sees: sign in as them after the owner resets it, or just
read what the walk left). Everything it did is in the audit log; the questions are recorded sealed, with a hash of the raw text.
The button **Assistant** is in the top bar of every screen; the panel opens beside the page, in the user's language.
- **Owner:** "Qu'est-ce qui est sorti aujourd'hui ?", "Combien de jours de couverture en ciment ?", "Qu'est-ce qu'il reste à facturer ?"
  (with amounts), then "Facture les BL BL-… BL-… pour CLT-…": a **card** shows the invoice as the database would make it (lines grouped by
  product, advance received, net to pay). Click **Confirmer**: a code from the authenticator is asked, then the invoice number is shown
  on the card. Then "Quelles factures sont impayées ?" and "Quelle est la prévision de la semaine ?" (amounts are put back from the
  stored figures). Open "Ce qui a été envoyé à l'IA" under any answer: codes and references, never a name or an amount.
- **Office:** "Quels BL ne sont pas encore facturés ?" (BL, date, m³, product, no amount), "Enregistre un chèque 8451237 de 12 000 dh de CLT-…":
  the card shows the method, number and date and **no amount** (blind, as the form), and confirming asks for the code too. "Quelles factures
  sont impayées ?" is a question office has no tool for: the answer is a refusal, with no figure.
- **Plant:** "Quel est le prochain chargement ?" (truck, time, m³, client code and the concrete type, which is the mix), "Où en est le silo de ciment ?"
  (tonnes and days of cover, no supplier or price), then "Enregistre le retour du BL BL-…, refusé par le client": a card for the return,
  which writes no money and needs no code.
- The drafts the walk leaves are **pending**: nothing is confirmed by a script, since a money draft needs its person's fresh second factor.
  They expire after 24 hours. In Arabic the same questions work in Arabic script or Darija ("أي السندات ما تفوترش بعد؟").
- If nothing waits to be invoiced when the owner's walk is played, the walk first has the plant load and deliver 3 m³ of an open order
  (through the plant's own door) so that there is a BL to invoice.
- The kill switches, the limits (20 questions in ten minutes, 200 a day) and the monthly budget (USD 20) are parameters in Administration.
  `corepack pnpm assistant:purge` empties the sealed payloads older than 90 days (not scheduled: run it daily).

## Not ready, or to say out loud
- The daily brief is template text from the same facts (the AI layer is not built). No notifications yet.
- Not wired: the nightly recompute job (the system role cannot read money tables; a decision for you). Alerts are stored
  when the owner opens the page. Postponements and advances are recorded as decisions but do not move the forecast until the
  ledger records what really happened (plan items are insert-only, there is no reschedule service).
- Worst-case-only deficits (post-dated cheques presented early) show as an alert but offer no options yet.
- Truck over-capacity and the reconciliation gap alerts wait for their modules.
- Office can no longer enter an order, quote or invoice by direct insert: it goes through database functions that return
  only the number (security fix, docs/checkpoints/CP-RE-1.md). The dev server needs no restart; the database is migrated.
- PDFs are French only: the standard PDF fonts have no Arabic letters, which print as "?" (an embedded font is a later step, decision 111).
- Not built: reconciliation with the plant software, notifications, the AI layer. (Stock counts and load cancellation have
  screens now: Stock and Chargements, owner only.)
- Each truck has a default driver (set on the dispatch page; the walk gave the first trucks theirs); overriding it on a rotation needs a reason. Fuel filled at
  a station is valued at the average price of the fuel bought. Rejected concrete stays billed until you issue an avoir.
- Decisions 97 to 113 are provisional until you confirm them (list in docs/checkpoints/CP-INTEGRATION-2.md).
- The older purchases of the scenario keep the former way (the payable comes from the order); only the new chain uses the supplier invoice as the source of the payable.
- The assistant (docs/SPEC-assistant.md, CP-ASSIST-1) is built and off by default; the walk below shows it with the scripted provider. The real provider is never used in the demo.
- A stock count counts in the period it is entered and measures everything since the previous count.
- Times shown on the tracking screen are formatted on the server in Casablanca time.
- The partner role still sees no money (decision 81, provisional). The plant sees and prints the client's name and the site on the delivery note (decision 83, provisional).
- The demo data is dated on the simulated clock: if the clock is moved a long way, "late" and "due" change accordingly.
