# REFERENCE-MAP.md — which reference inspired which screen

Derived from [RESEARCH.md](RESEARCH.md) (research date 2026-10-18) and DECISIONS. Read it with one caveat: RESEARCH.md paraphrases public product pages and data sheets; nobody on the project used these products. "Inspired" means *the capability category exists there and told us the screen is worth having*, never that a layout or flow was copied. Items marked (our own) have no reference: they come from the owner's workshops and the Moroccan context. The security rules of CLAUDE.md apply to every screen listed here.

## 1. The references

| Short name | What it is (RESEARCH.md) | What we took from it |
|---|---|---|
| **Ready-mix suites** | Command Alkon Integra / COMMANDseries, Jonel (§1): quote-to-cash, order entry, scheduling, ticketing, truck tracking, invoicing and receivables, inventory, credit. | The shape of the chain from quote to cash, and that dispatch, ticket and invoice belong in one system. |
| **Batching export** | COMMANDbatch (§2): shipment and production data exported as CSV/XLS/XML; dispatch sends the mix to the batching system and receives the batched quantities. | File import as the realistic pilot path to the plant software (ARCO GOLD TWO in our case, DECISIONS open question 3). |
| **Manufacturing tools** | Daftra (§1): bills of materials and raw-material consumption, not concrete-specific. | Recette as a bill of materials; theoretical against actual consumption. |
| **Cash forecasting** | Agicap (§1): scenarios, auto-categorized inflows and outflows, no knowledge of concrete or Moroccan instruments. | Forecast with scenarios and alerts; we feed it Moroccan instruments instead of bank categories. |
| **Odoo (negative reference)** | Not in RESEARCH.md; DECISIONS "Reasons behind key choices": Odoo failed because entry was heavy. | The rule that entry stays light: documents flow without re-typing (the integration wave) and the assistant only drafts. |
| **Messaging platforms** | WhatsApp Business, Telegram bots (§5). | Buttons that answer with a tap; no sensitive content in messages. |
| **Rules of the trade** | 90-minute discharge rule, ~30 min unloading, truck capacities (§3). | Parameters, never constants: `concrete_limit_min`, `unloading_min`, per-truck capacity. |

## 2. Screens

| Screen (route) | Inspired by | What we do differently |
|---|---|---|
| Quotes (`/quotes`) | Ready-mix suites: quote entry | Prices come from the price in force, resolved by the database, never typed; office enters blind and gets a code, not an amount (D81). A quote converts into an order by a human saving a prefilled form. |
| Orders and payment plan (`/orders/new`, `/orders`) | Ready-mix suites: order entry | The order carries a payment plan in Moroccan instruments (advance, cheque, LCN, instalments, cash); the plan items are the receivable truth. Money in integer centimes; office blind. |
| Order chain (`/orders/chain`) | Ready-mix suites: quote-to-cash tracking | One row per order with ordered, planned, loaded, delivered, invoiced, paid; every role reads quantities and stages, only owner and support see "paid", nobody sees an amount here. |
| Related documents and search by number (panel on each document, top-bar box) | (our own) | Links come from database relations and are filtered by the caller's row-level security; a search finds document numbers only, never a client name, audits its misses and locks out probing. |
| Dispatch (`/dispatch`) | Ready-mix suites: scheduling and dispatch | Rotations cut by truck capacity with times from parameters and the zone's one-way time; a default driver per truck with an audited override; overdue orders flagged by colour and text; the human saves the plan, replanning cancels with a reason. |
| Where is my truck (`/dispatch/office`) | Ready-mix suites: truck tracking | Read-only for office through one reviewed database function: truck, times, m³, client name, step; no price, no order, enforced in the database (D113). |
| Trip tracking (`/trips`) | Ready-mix suites: ticketing and truck tracking | Six steps, one tap each, on a phone; no GPS in the pilot; waiting and unloading times are derived, never typed; the first step is the load, so a rotation is tied to its BL. |
| Loads and delivery notes (`/loads`, `/deliveries/[id]`) | Ready-mix suites: ticketing; Batching export | BL numbers per year, quantities only (no price on a BL), delivered by the unloading step, signed BL with an optional scan (type and magic bytes, metadata stripped, sealed at rest, opened by an audited route). The plant import is a file, not an integration (decision open). |
| Invoice queue and invoices (`/invoices/queue`, `/invoices`) | Ready-mix suites: invoicing and receivables | An invoice is made from the selected delivered BLs in one action, lines grouped by product with the BL numbers, advance shown as "Acompte reçu" and "Net à payer", a BL on one invoice only (database constraint); 69-21 terms on the document; a server-generated PDF with a pilot watermark. |
| Payments and allocation (`/payments/new`, `/cash`) | Ready-mix suites: receivables; Cash forecasting | Instruments with their own life (received, deposited, cleared, bounced, regularized, disputed); allocation across open invoices oldest due first; a bounce reverses by reversing entries and keeps the 30-day alert of law 71.24. |
| Avoirs (`/avoirs`) | Ready-mix suites: credit modules | Owner only, step-up, references invoice + BL + return record, own numbering, never edits the invoice (no hard deletes). |
| Statements (`/statements`) | Ready-mix suites: receivables | Client and supplier statements with a commercial and a financial section and running balance; CSV and PDF exports are audited. |
| Cash forecast and alerts (`/cash`, dashboard) | Cash forecasting | The forecast is a deterministic rules engine over the instruments and plan items, with ranked resolution options a human confirms; the AI only explains, never ranks or computes (D38). |
| Purchases, supplier invoices, three-way match (`/purchases`, `/supplier-invoices`) | Ready-mix suites: inventory and purchasing modules | The supplier's invoice is its own document matched to the order and the receipts (quantity, price, line not on the order) with tolerances as parameters; gaps block approval until the owner accepts them with a reason and a fresh second factor; the payable comes from the approved invoice, not from the order. A photo is attached; AI reading of it exists only as an interface behind a flag that is off. |
| Stock, receipts, reorder (`/stock`, `/receipts`) | Ready-mix suites: inventory; Manufacturing tools | Receiving a purchase moves stock by quantity (no amount for the plant); days of cover under open orders and an order-by date; the reorder suggestion is a draft for the owner and hides supplier and price from plant and partner. |
| Recettes (`/master-data/recettes`) | Manufacturing tools: bill of materials | Versioned by effective date, so a later change never rewrites a past load's consumption; quantities only for the plant, no cost for office. |
| Consumption report (`/reports/consumption`) | Manufacturing tools: raw-material consumption | Theoretical from the loads against actual from the count adjustments; flagged above a tolerance parameter; lost concrete has its own lines. |
| Fuel (`/fuel`) | (our own) | Litres and kilometres are quantities; purchases and the cost per litre and per m³ are money (owner). |
| Sales analytics (`/analytics`) | (our own) | m³ per day, week, month by client, type, zone; amounts for owner and support only. |
| Law 69-21 deadlines (`/deadlines`) | (our own, RESEARCH.md §4) | Alerts and the quarterly figures from invoice dates; the certified statement stays with the accountant. |
| Accountant's files (`/accounting`) | (our own) | CSV files for a period, every download audited. |
| Master data: clients, suppliers, trucks, zones, prices | Ready-mix suites: master files | Archive instead of delete, ICE uniqueness with a recorded override, price lists with per-client overrides readable by the owner only. |
| Owner dashboard (`/`) | Cash forecasting | One screen of the few figures the owner asks every morning, each leading to its screen; nothing computed in the browser. |
| Notifications (Telegram, later WhatsApp) | Messaging platforms | Minimal and without sensitive content: a code and a button, never an amount or a name (bot chats are not end-to-end encrypted). |
| Assistant (specified, not built; [SPEC-assistant.md](SPEC-assistant.md)) | Odoo as the cautionary tale; Cash forecasting for the explanation role | Tool-calling over the services the screens use, numbers only from tools, drafts confirmed by a human; off until the CNDP authorization. |

## 3. What no reference told us (and we decided ourselves)
- **Security model**: roles, row-level security, column grants, blind entry for office, step-up second factor, hash-chained audit, encryption at rest, fake-data pilot. None of the references was studied for this.
- **Moroccan instruments and law**: post-dated cheques payable on sight, LCN, law 71.24 on bounced cheques, law 69-21 payment terms, CNDP declaration and authorization, DGI e-invoicing (status unclear, to verify with the accountant). RESEARCH.md §4.
- **Integer centimes and reversing entries** as the only way money is stored and corrected.
- **Documents flow without re-typing**: delivered → signed → invoiced → paid, and purchase order → receipt → supplier invoice → payable, each step a link to the previous one (CP-INTEGRATION).

## 4. Gaps against the references (honest list)
- No GPS or live map of trucks (the references track trucks; we track steps by tap).
- No automatic exchange with the plant's batching software (file import only, format unknown).
- No official e-invoicing yet (data model ready; obligation and date to verify).
- No customer portal and no driver app.
- The Arabic PDF layout needs an embedded font (D111): documents are French only for now.
