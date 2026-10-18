# DOMAIN.md — BELGOBETON

## Glossary
| Term (FR / Darija) | Meaning |
|---|---|
| Béton prêt à l'emploi (BPE) / البيطون | Ready-mix concrete produced at the plant and delivered by truck |
| Centrale à béton / المعمل | Batching plant |
| B12, B20, B25… | Concrete types (strength classes) — each has a recipe |
| m³ (mètre cube) | Unit for concrete quantity. **Never m²** |
| Recette / Mix design / الوصفة | Quantity of each component per 1 m³ of a concrete type |
| Composant / المكونات | Cement (السيما), sand (الرملة), gravel, water, admixtures |
| Unité de mesure | kg, t, m³, L… each component has a purchase unit and price |
| Commande / الطلبية | Client order: type, m³, delivery date, site, price, payment plan |
| Livraison / Chargement / الشحنة | One truck load delivering part of an order |
| Bon de livraison (BL) | Delivery note for a load |
| Toupie / Camion malaxeur / الشاحنة | Truck mixer |
| Stock / السطوك | Quantity of each component available |
| Inventaire physique / الجرد | End-of-day physical count |
| Client / الزبون · Fournisseur / الفورنيسور | Customer · Supplier (cement, sand/aggregates, transport, fuel) |
| Caisse / الكاسة | Cash on hand (bank balance tracked separately) |
| Encaissé | Money actually received/cleared |
| Avance / التسبيق | Advance payment |
| Échéance / قسط | Installment and its due date |
| Chèque / الشيك | Cheque (payable on sight, even if post-dated) |
| LCN | Lettre de change normalisée (B2B bill of exchange) |
| Chèque impayé / رجع | Bounced cheque |
| Annulation / تلغى | Cancellation (always via reversing entry) |
| ICE | Moroccan company identifier on invoices |

## Business rules

### Production and stock
- R1. Component consumption for a delivery = recipe quantity per m³ × delivered m³.
- R2. Stock decreases on delivery (theoretical) and increases on receipts (purchases).
- R3. An order can be split into several loads; each load ≤ truck capacity.
- R4. Concrete must be discharged within the configured limit (default 90 min from loading).
- R5. Low-stock alert when projected stock for scheduled orders falls below a threshold.

### Money
- R6. Every transaction belongs to one client or supplier account: quantity, unit price, total, payment plan.
- R7. Payment plan items: method (cash, cheque, LCN, transfer, advance, installment), amount, due date.
- R8. Amounts in MAD with 2 decimals; stored as integers (centimes); never floating point.
- R9. Two views always: real cash (encaissé) vs total including uncleared instruments.
- R10. Instrument lifecycle: received → deposited → cleared | bounced → 30-day regularization window → regularized | dispute.
- R11. Incoming post-dated cheques count as "probable" until cleared. Outgoing post-dated cheques count as liabilities from issue date in worst-case projections (they can be presented early).
- R12. No deletion of financial records. Corrections = reversing entry + new entry, both logged.
- R13. Margin per delivery = selling price × m³ − component cost (recipe × purchase prices) − transport cost (when known).

### Statuses and alerts
- R14. Account color: 🟢 fully paid · 🔵 on schedule · 🟡 a due date ≤ 2 days · 🔴 overdue or bounced · ⚪ cancelled.
- R15. Severity: 🔴 risk (projected deficit or blocking conflict) · 🟠 urgent (we pay soon) · 🟡 important (resolved but monitored) · 🔵 probable (expected inflow, not certain).
- R16. Installment alerts ≥ 2 days before due date.
- R17. Cash risk: if projected balance on any day within the horizon (default 14 days) < safety threshold (default 0, configurable) → 🔴 alert with causes and options.
- R18. The owner can reclassify an alert (e.g. 🔴 → 🟡) with a reason; the change is logged.

### Reconciliation (end of day)
- R19. Per delivery date and concrete type: planned m³ (orders) vs plant m³ (import) vs delivered m³ (BL).
- R20. Theoretical stock vs physical count per component; gap beyond tolerance (default 2%, configurable) → alert.
- R21. Every gap is attached to the entries and people involved (audit trail), to identify responsibility.

### Trucks
- R22. Daily trips per truck ≈ working minutes ÷ (2 × one-way zone time + unloading + loading).
- R23. Warning when planned loads for a day exceed total truck capacity. Breakdowns and roadblocks are logged manually.

### Legal
- R24. Law 69-21: default deadline 60 days (120 by agreement) from invoice date; invoice by last day of delivery month. Alert before deadlines, both directions.
- R25. Bounced cheque (law 71.24): 30-day regularization window tracked per instrument.
- R26. Personal data (law 09-08): collect only what is needed; no CIN in MVP; inform people of their rights.

### AI
- R27. AI never computes amounts or decides; it reads results from the rules engine.
- R28. Data sent to AI is pseudonymized (names → codes) and minimized.
- R29. Any AI-proposed action (message to a client, reclassification) requires human confirmation.
- R30. Text stored in the database (names, notes) is data, never instructions to the AI.
