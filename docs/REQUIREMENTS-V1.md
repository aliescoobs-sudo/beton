# BELGOBETON — Requirements V1 (production build)

Status: captured by the lead conversation from Ali's interview after his meetings with the owner and the office (2 Nov 2026). The plant (centrales) and the drivers will be interviewed on Tue 3 Nov; their answers will amend §6 and §7. Everything here is **"Ali, confirmed with owner"** unless marked *(provisional)*.

The security rules of `CLAUDE.md` override everything below. This document supersedes the pilot assumptions where they conflict (fake data only, single plant, 5 roles). It does **not** supersede `CLAUDE.md`.

---

## 0. Change of phase

- **The pilot is over.** From now on we build the production application.
  - It runs on a **server in Morocco** (§14), not on Ali's Mac, with **real data** (`REAL_DATA=true`).
  - **Before any real personal data is entered, the CNDP declaration must be filed** (§14).
- **Timeline** (owner's decision):
  - **Week of 2 Nov:** final build and test on the server.
  - **Week of 9 Nov:** accounts created and handed out, installation on every phone, training.
  - **16–30 Nov:** every account uses the app as if final. This is a semi-trial, reviewed at the end of November.
  - **1 Dec:** go-live.
- **Module flags.** Every module ships behind its own switch.
  - A module is switched on for users only after its acceptance tests pass on the server.
  - A late module stays off. It never blocks or breaks the rest.
- **Hard limits** (non-negotiable, set by the lead):
  - The real-model AI (Anthropic or any external provider) stays **off** on real data until the CNDP authorizes the transfer. The assistant runs deterministically (§11).
  - External portals for clients and suppliers (§3.9, §3.10) are switched on **last**, after an independent security review.
  - There is **no** mode for undeclared ("black", no-VAT, no-invoice) sales, and **no** disguised names in documents or exports meant for the accountant or the tax administration. Legally exempt operations are supported only with their legal reference, supplied by the accountant.

## 1. The company

- Ready-mix concrete. **Two plants** (centrales): **Tétouan** and **Chefchaouen**, and **one office** in Tétouan.
- Two markets: Tétouan and Chefchaouen. Statistics, stock, orders and finances are **per plant and in total**.
- **Products:** ready-mix concrete of all types, delivered by truck mixer (malaxeur). Transport is **included** in the m³ price. **Pumping** is a service (§4).
- No precast products.
- **Alternative financing:** steel shipments (§10).

## 2. Fleet and people

**Truck mixers (9 active):**

| Plant | Trucks | Status |
|---|---|---|
| Tétouan | 4 × 16 m³ | New, leasing |
| Chefchaouen | 4 × 11 m³ | New, leasing |
| — | 1 × 10 m³ | Old, active |

- **4–5 old trucks are stopped** by breakdowns. They are kept in the fleet with the status "stopped – breakdown" and a decision field: *repair and use*, *repair then sell*, or *sell as is*. Details later.
- **Pumps:** 3 pump trucks, not tied to a plant. They move between the two plants as needed.
- **Each machine has its own driver.**
- **External trucks** are hired under pressure. How they are paid (per trip, per m³ or per day) is *(unknown)*, so make it configurable.
- **Fuel:** a tank at the plant is the normal source. A station, paid by voucher (never cash), is rare.
- **Office:** 2 employees, split between *sales* and *purchases & payments*.
- **Accountant:** keeps the parallel tax accounting (TTC, VAT, tax obligations). Takes **Excel** files.

## 3. Accounts (roles)

Money visibility rule:
- Only **owner** and **app_admin** see amounts, balances, cash, bank, P&L, loans and financing.
- Every internal account may see quantities, stock, orders and the **reference average** buy and sell prices *(drivers and pumpers excluded)*.

### 3.1 owner (المدير)
- Sees and does everything. Approves (§12). Receives every alert.
- Main devices: **iPhone first**; iPad with keyboard and mouse for detailed, wide screens. No desktop.
- The **assistant is his main entry point**: it answers any question without browsing, sends alerts and keeps a continuous conversation (§11).

### 3.2 app_admin (Ali)
- Owner-equivalent access to everything, including money.
- **Plus** administration of the application: users, roles, parameters, plants, fleet, price lists.
- Mitigations (required):
  - every action is audited and visible to the owner;
  - step-up for sensitive actions;
  - cannot delete or alter the audit log;
  - cannot remove or downgrade the owner.

### 3.3 office_sales
- Clients, orders, quotes. The order price is filled automatically with the provisional reference price (§4).
- Sees the dispatch and trips **with client names**. Handles alerts and calls clients.
- Prints and sends BLs and invoices: sees the amounts on the document being printed, never balances or treasury.
- **Balances:** status only. "Owes / does not owe", "late / not late". Never the figure.
- May **cancel an order** that has not left the plant (§8), with an optional reason. The owner and app_admin are alerted immediately.
- May **request** the cancellation of an issued invoice, with a mandatory reason from a list.
- May edit client payment terms (templates, §5).
- Records payments received (cash, cheque, LCN) **blind**: types what is in hand and sees no balance.

### 3.4 office_purchases
- Suppliers. Purchase orders with status: ordered, expected on date, arrived on time, late, cancelled.
- Receipts are entered after the plant has confirmed them.
- Supplier invoices. Fuel purchases. External truck hires.
- Supplier status only: "we owe / we do not owe".
- Records outgoing payments blind.

### 3.5 plant_manager — one per plant (Tétouan, Chefchaouen)
- Owns, for **his plant only**: stock, production and loading, the first confirmation of receipts, the fuel tank and its dispensing per truck, stock counts, truck availability and recipes (read).
- No money.

### 3.6 driver (truck mixer)
- Own trips only. Phone interface (§7).
- No price, no amount.
- Sign-in by short PIN plus device binding.

### 3.7 pump_operator
- Own pump jobs. Same pattern as the driver, with pump steps: arrived, set up, pumping started, pumping ended (m³ pumped), left.
- No money.

### 3.8 accountant
- Excel exports: sales and purchase journals, HT / VAT / TTC, avoirs, VAT summaries.
- Reads invoices with amounts. No treasury, P&L, loans or steel module *(provisional, confirm with owner)*.

### 3.9 client_portal — regular clients, each sees only their own data
- Their orders, deliveries and BL status, and their payments.
- Requests a document (quote, BL, relevé, invoice). Figures are shown only after the owner or app_admin approves that request (§12).
- **Enabled last** (§0).

### 3.10 supplier_portal — each sees only their own data
- Their purchase orders, delivery schedule and payments.
- Same approval gate for figures.
- **Enabled last.**

### 3.11 Existing roles
`partner` is not used (the owner has no partner in the app). `support` is replaced by `app_admin` for Ali. Keep `support` read-only for maintenance accounts, unassigned.

## 4. Prices

- Prices are **not fixed**. The same product can leave the same day at different prices, for sales and for purchases.
- A **reference average price** per concrete type is configured *(per plant? provisional: per plant)*.
- A new order takes the reference price as a **provisional price**.
- **An invoice cannot be issued while any of its lines has a provisional price.**
  - The owner or app_admin confirms the real price.
  - The assistant pushes "N orders at provisional price, confirm" to the owner's phone, and he confirms in one tap per order or in bulk.
  - Every confirmation is audited.
- Profit is computed on confirmed prices only.
- **Purchases:** the real price comes from the supplier invoice (three-way match, already built).
- **Pump:** a surcharge per m³ pumped *(provisional)*. Transport is included in the m³ price.
- **Waiting time on site** is not billed (own trucks, salaried drivers) but is **recorded** per client for analysis.
- **Excess load:** billed if actually unloaded. The driver enters the m³ unloaded. The owner or app_admin can adjust.

## 5. Clients, terms, credit

- Each client has their own terms: advance or not, installments and their split.
- Templates follow standard market practice. office_sales, owner and app_admin can edit a client's terms.
- **Credit limit per client.** An order that exceeds it, or from a client with overdue invoices, stays **pending** until the owner or app_admin approves it from the phone. The office sees "pending approval", never the figure.

## 6. Plants, stock, purchases

- Stock is per plant. Consumption by recipe is already built; make it per plant.
- **Reorder thresholds per component and per plant**, based on that component's lead time and the average daily consumption.
  - The average comes from historical months, imported later.
  - Example: cement from a single supplier (Holcim) needs ordering more than 2 days ahead; sand can be ordered the day before or the same day.
  - Defaults follow market practice until the history is imported.
- **Receipt flow:** the plant manager confirms the receipt first, office_purchases confirms with the supplier and enters the details, and then stock goes up.
- Purchase orders are entered case by case. Suppliers vary, except cement.
- *Plant interview on 3 Nov will refine:* recipes per plant, ARCO, silo capacities, fuel tank, stock counts.

## 7. Driver and pump phone flow

**Normal chain — one big button, one tap per step:**
1. Loading started.
2. Truck left the plant.
3. Arrived on site.
4. Unloading started.
5. Unloading ended. Enter the m³ unloaded; optional photo of the signed BL.
6. Back at the plant.

If a next load is assigned, the screen goes straight to "start next order". Otherwise it shows "idle at plant".

**Emergency button, always visible.** Its options depend on the current step. Examples:
- *Unloading:* the current percentage unloaded is shown, with options such as "load not enough for the client", "client stopped", "site not ready" and "quality refused".
- *On the road:* "breakdown", "accident", "heavy delay", "client cancelled", "site closed".

**Handling an emergency:**
- The alert goes to the office, owner and app_admin. They call and act in the app.
- The driver's screen then switches to one of:
  - **continue** the normal chain;
  - **return for an extra load**;
  - **redirect** to another site, with address and map link and an "I acknowledge" button;
  - **join / be joined** by another truck that has a likely excess.

**Other rules:**
- **Offline-first:** taps are queued with their timestamps and synced when the network returns.
- Large Arabic text with icons. Language per user (§13).
- Shows site, address, map link, site contact, quantity and type. **Never a price.**
- *Driver interview will refine the steps and the emergency list.*

## 8. Cancellation and incidents (the seven cases)

1. **Order recorded, not planned.** Office cancels, reason optional. Owner and app_admin are alerted. No stock or money effect.
2. **Planned, not loaded.** Office cancels. **Urgent alert** to the plant and to the assigned driver(s): "cancelled, do not load". Trucks are freed and the plan reflows.
3. **Mixed or loaded, not left.** The material is consumed, so this is no longer an ordinary cancellation.
   - The app proposes same-day open orders that could take it: same type or a lower one (B25 can serve B20), with enough remaining workable time.
   - Choice: redirect or loss. Decided by the owner or app_admin, or by the plant manager if allowed *(provisional)*.
   - The BL keeps its number and is marked "annulé", never deleted.
4. **On the road.** Same proposals, with workable time counted from mixing.
   - Redirect: the new address goes to the driver, who acknowledges.
   - Otherwise return and **loss record** (materials, fuel, time).
   - Whether the cancelling client is charged is *(provisional, owner policy, configurable)*.
5. **Unloading stopped midway.** The driver enters the m³ unloaded, which is billed. The rest is redirected if enough and in time, otherwise returned as a loss.
6. **Truck incident** (breakdown, accident, heavy delay). Emergency, urgent alert. The app proposes another truck for the rest of the order. The truck enters the breakdown log and leaves the planning until repaired.
7. **Rejected on site.** Reason mandatory, optional photo, quality sample recorded, then redirect or loss. If already invoiced, only the owner or app_admin issues the avoir.

**Plus:** "load not enough" (from the driver's emergency): return for an extra load, or another truck joins.

## 9. Documents

| Document | When | Content |
|---|---|---|
| **Devis** | At order entry | Quantity, type, provisional price, terms. |
| **BL** | One per load | No price. A 30 m³ order over 3 days gives several BLs, all linked to the order. |
| **Relevé de situation** | Any time | Delivered, paid, remaining, upcoming installment dates. **Not a fiscal invoice.** Office prints it; clients get it after approval. |
| **Facture d'acompte** | Optional | For a significant advance. |
| **Facture définitive** | Timing is a parameter, chosen by the accountant: at full payment, monthly recap, or per delivery | All BLs, advances deducted, net to pay, legal mentions. Sequential numbering continues from the company's last 2026 invoice number. |
| **Avoir** | On demand | Owner or app_admin only. |

- Every number-bearing document a client requests passes the approval gate (§12).

## 10. Finance (owner and app_admin only)

**Expenses:**
- **Fixed:** leasing installments of the 8 new trucks, salaries (including the owner's own salary, so the cash stays clear), office rent, other fixed costs.
- **Variable:** fuel, maintenance and repairs, external truck hire, and other variable costs.
- Categories are configurable.

**Revenues and financing:**
- Revenues: concrete sales and pumping.
- Financing: bank and leasing loans, each with its schedule.

**Steel financing module — "تكلفة التمويل بالحديد":**
- Steel goes **directly** from the supplier (Casablanca) to the buyer.
- The buyer pays the **full amount in cash on delivery day**, recorded into the cash.
- The company pays the supplier with **post-dated cheques spread over 90 days, starting one month after delivery**.
- The sale price is below the purchase price. The difference is recorded as the **financing cost** of that deal, under that honest name.
- The module shows, per deal: cash in, cheques and their dates, and the cost.
- It compares that cost with a bank loan.

**Reports:** P&L monthly, quarterly, half-yearly and yearly, per plant and in total.

**Cash forecast:**
- Includes cheques in and out, installments, leasing, salaries, steel cheques and expected collections.
- It flags periods needing extra liquidity and can suggest one or more steel deals to cover a forecast gap.
- All figures are computed by deterministic code; the assistant only explains them.

**Treasury:**
- Cash can be held by the owner or by the office, or go straight into the company account. Track who holds what.
- Outgoing cheques are signed by the owner.

**Accountant exports:** Excel. The office may also convert.

## 11. Assistant

- It has the full picture and does analysis, forecasts, installment follow-up, financing and steel planning.
- **Non-money roles** get honest answers **without figures**, about **recorded operations only**. Example: "cheque CHQ-… due Thursday: covered / tight / needs action".
  - It never answers yes/no about an amount the user picks.
  - Financial questions are limited per user per day.
  - The owner and app_admin get a daily digest of who asked what.
- **Figure disclosure:** when a user insists on a figure, the assistant answers "waiting for approval" and creates an approval card for the owner or app_admin (§12). On approval, the figure is shown to that user only, once, and audited.
- **On real data, until the CNDP authorization:** no external LLM. The assistant works through:
  - the existing tools and deterministic intent matching (quick questions as buttons, plus a typed question when a scripted match exists);
  - deterministic reports.
  
  The Fake/scripted provider infrastructure (A0–A11) is the base. The Anthropic adapter stays locked.
- **Reports:**
  - application performance and anomaly detection (errors, stuck trips, unusual cancellations, stock variance, late confirmations);
  - **field surveys:** short in-app questionnaires per role about what the user must do in the app. Results go to the owner and app_admin.

## 12. Approvals inbox (owner and app_admin, on the phone)

One inbox with push notification. Each card shows exactly what will happen, confirmed in one tap, with step-up where money is written:
- provisional prices to confirm;
- orders over the credit limit or from late payers;
- invoice cancellation requests;
- figure-disclosure requests;
- client and supplier document requests;
- avoirs;
- redirect or loss decisions (§8), if routed to them.

## 13. Notifications and languages

**Notifications:**
- The **app is the channel**: an in-app notification centre plus push, with the app installed on iPhone from the browser (PWA).
- WhatsApp and SMS carry only a content-free ping ("you have an alert"), in a later step.

**Events:**
- every shipment delay at any stage, sales and purchases, especially versus scheduled delivery and receipt times;
- cancellations;
- emergencies;
- approvals pending;
- stock thresholds;
- cheques due or bounced;
- receipts late.

**Languages:** Arabic, French and **Darija** (Arabic script). Each account has a main language and can switch.

## 14. Hosting, legal, data

- **VPS in a data centre in Morocco**, to keep data in Morocco. Choice criteria, in order: stability, security, cost.
  - HTTPS, firewall, database not exposed;
  - SSH by key only;
  - encrypted daily backups to a second location in Morocco, with restore tested;
  - monitoring and security updates.
- **CNDP:** the company has no file yet. Prepare the declaration (employees, clients, suppliers, drivers' data) **before** entering real personal data. Driver geolocation is *not* in V1. If wanted later, it is a separate CNDP point.
- **Data import:**
  - from Excel: clients, suppliers, products, price list, trucks, opening balances, cheques in transit;
  - from paper: entered by the office;
  - history of previous months: later, for consumption averages.
- **Last invoice number of 2026:** to be supplied.

## 15. Open points

- Plant interview (3 Nov): recipes, ARCO export, silos, fuel tank, counts, loading practice, who decides redirect or loss.
- Driver interview (3 Nov): steps, emergencies, phones (Android or iPhone), network on sites.
- Owner: external truck pricing, cancellation fee policy, reference price per plant or global, accountant read scope.
- Accountant: final invoice timing (§9), legal exemptions with references, export format.

## 16. Amendments after Codex's independent review (2 Nov, accepted by the lead)

1. **Information-visibility matrix (replaces the loose "money only for owner and app_admin" wording).** For every money item, state four rights separately:
   - who **enters** it;
   - who **sees it inside a document**;
   - who **sees balances and aggregates**;
   - who **exports** it.

   Entering or printing never grants balance or aggregate access. The known exceptions:
   - office_sales prints invoices with amounts;
   - office_purchases enters supplier invoices and payments;
   - the accountant exports HT, VAT and TTC;
   - reference prices are visible to internal non-field roles.

   Write the matrix in CP-PROD-PLAN.md and enforce it in the database with exposure tests.
2. **Document library filtered by role and document type.** Every download re-checks permission and RLS server-side.
3. **Figure-disclosure approval is scoped:** to a user, a data item (and its document, if any), and a duration (default single view, expiry 15 minutes). Every view is audited.
4. **Assistant financial answers** concern only recorded operations the user is allowed to follow. They never answer a user-chosen amount ("can we pay 50k?", "and 40k?"); such questions are refused, not just rate-limited.
5. **Inter-plant flows:**
   - transfers of materials and fuel between Tétouan and Chefchaouen (out, transit, received, variance, who is responsible at each step);
   - an order or a truck served by the other plant: who produces, who delivers, and where the cost and revenue are booked (default: the producing plant books the material cost; revenue goes to the order's plant; *provisional*).
6. **Pump coordination:**
   - pump availability, travel, set-up and pumping capacity in the planning;
   - a truck must not be dispatched to a pumped pour before the pump is scheduled to be on site;
   - a conflict raises an alert.
7. **Receipt states:** ordered, physically arrived, available for production, documentarily accepted. Also partial and rejected quantities, with the weighbridge ticket or delivery note attached.
   - The plant can produce from "arrived / available" before the office completes the paperwork.
   - Stock shows both states.
8. **One timeline per order:**
   - entries: recorded, planned (and every re-plan), mixed, left, arrived, unloading, unloaded, returned, BL, invoiced, collected;
   - each entry with its actor, the device time and the server sync time, so offline taps stay traceable.
9. **Day close per plant:**
   - unconfirmed loads and missing BLs;
   - stock variance and fuel variance;
   - cash held per holder.
   
   Blocking items go to the owner's approvals.
10. **Redirect proposals** need a technical compatibility check of the mix for the destination use, not only "same grade or lower". The plant manager confirms technically before the office or owner confirms commercially.
11. **Finance report structure:**
    - plant results first, then central costs (financing, steel cost, head office), then the total;
    - name it **"Résultat de gestion (données enregistrées)"**, not "net profit", until the accountant validates the rules;
    - material cost is based on **consumption**, not purchases;
    - shared costs and pumps are allocated by an explicit, configurable key;
    - loan principal is separated from financing cost, and leasing gets an explicit treatment;
    - no commitment is counted twice (an installment and its cheque are one commitment).
12. **Steel suggestion:** it must simulate the cash brought now **and** the cheques it creates later. It is proposed only if no larger gap appears in the following months.
