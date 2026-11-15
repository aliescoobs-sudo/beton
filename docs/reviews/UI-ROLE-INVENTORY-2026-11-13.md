# UI inventory and role/flow gap analysis (read-only, 13 Nov 2026)

Source: `main` at the T10j/R22 state. Evidence is `file:line`. Nothing was implemented. Ali's four answers of 13 Nov are **to be confirmed with the owner**. Menu lists were computed from `src/app/shell/nav-model.ts` and the matrix in `src/modules/platform-security/domain/permissions.ts` (abbreviated `perm.ts`). `/security` and the dashboard are in every menu.

## A. Per role: screens, home, powers

One home page for everyone (`src/app/[locale]/(protected)/page.tsx:20–120`): a role with `cash.read` (owner, app_admin) gets `OwnerToday` (money dashboard); every other role gets `OpsToday` (`loadTodayOps`, `src/modules/rules-engine/service/dashboard-service.ts:106–135`: orders to load, stock risk, stock alerts), plus "delivery exceptions" for `trips.read` roles, plus entry **shortcuts** (`home-tiles.tsx:5–16`: Nouvelle commande, Nouveau devis, Saisir un paiement, Facturer une commande, Nouvel achat, Chargements, Réceptions). There is no per-role home layout.

The menu is one top bar of 7 groups (Ventes, Achats, Trésorerie, Production, Données de base, Administration, plus Tableau de bord), filtered by permission (`nav-model.ts:14–452`). Link counts: owner and app_admin 59 each, plant_manager 26, office_sales 25, office_purchases 22, accountant 8.

| Role | Menu (what it reaches) | Home shows | Creates / edits | Approves | Exports / reads money | Receives from others |
| --- | --- | --- | --- | --- | --- | --- |
| **owner**, **app_admin** (identical menus; `V1_POLICY_ROLE`: app_admin→owner, perm.ts:25–30) | everything: orders list, quotes, approvals, credit limits, payments, invoices, avoirs, accounts, statements, instruments, deadlines, cash, opening, accounting export, dispatch, trips, stock, receipts, day close, users, field accounts, parameters, company, history staging | money dashboard (cash, forecast, stock, loads) | all (BLIND_SALES/PURCHASES + MONEY_WRITE: perm.ts:166,168,174) | prices, credit holds, disclosures, avoirs, supplier invoices, day close force (`approvals.decide` perm.ts:174; D130–132) | `accounting.export`, `cash.read` | approval inbox, cheque/cash/stock alerts, day-close blocking |
| **office_sales** | clients, quotes/new, orders/new, orders/chain, invoices/queue, invoices/new, **payments/new**, documents(+requests), disclosures, dispatch/office (read-only), pumps, cancellations, emergencies, loads, surveys, master data (read) | `OpsToday` (loads only; no stock read) + shortcuts | orders and quotes (blind, perm.ts:154), invoices, payments (`instruments.write` perm.ts:166), BL return, `trips.correct` | nothing | amounts only of the document it prints (`documents.invoice` perm.ts:204; D128); balance status flags | alerts RCV-DUE/OVERDUE, INVOICE-MONTH-END, DAY-CONFLICT, CHQ-BOUNCED (`0089_notifications.sql:98–106`). **No order list** (`orders.read` excludes it, perm.ts:148) |
| **office_purchases** | purchases/new, supplier-invoices/new, receipts, suppliers, clients (read), orders/chain, payments/new, documents, disclosures, cancellations, emergencies, loads, surveys | `OpsToday` (no stock read: `stock.read` perm.ts:341 excludes it) | purchases, supplier invoices, receipts (`receipts.write` perm.ts:350), outgoing payments blind (D128) | nothing | none | STOCK-LOW / STOCK-SHORTAGE, PAY-DUE, CHQ-BOUNCED (`0089…:100–103`). **No /stock, no /stock/projection** |
| **plant_manager** (one plant) | dispatch, trips, loads, stock, stock/projection, receipts, transfers, day-close, fuel, pumps, cancellations, emergencies, consumption report, history (quantities), master data (read) | `OpsToday` with stock risk and stock alerts + delivery exceptions | stock, receipt arrival confirmation, transfers, day close, dispatch (plan/reassign), fuel, trucks status (`dispatch.write` perm.ts:309, `receipts.confirm_arrival`, `dayclose.write`) | cancellations (`cancellations.decide`) | none (no money keys) | STOCK-LOW/SHORTAGE, DAY-CONFLICT, cancellations, transfers |
| **accountant** | documents (+requests), invoices, avoirs, accounting export, surveys, history (expense), company | **empty** `OpsToday`: no `deliveries.read`, no `stock.read`, no `cash.read` → nothing to show but shortcuts (none) | document policy (`documents.policy` perm.ts:187), document requests | nothing | `invoices.read`, `avoirs.read`, `accounting.export` (perm.ts:219,358; D129 provisional). No instruments, payments, orders | none |
| **driver**, **pump_operator** | separate phone app `/fr/driver` (`src/app/[locale]/driver/page.tsx`, `FieldApp`), own code+PIN login, not the office menu | today's rotations (driver) or pump jobs (operator) from the server clock | stage taps, BL photo, emergencies, cancellations seen | — | — | office instructions, dispatch plan, `driver_instruction` push |

## B. Cross-role links that exist, and those missing

Exist today:
- **Order chain page** `/orders/chain` (`orders.chain`: every internal role, perm.ts:151): quantities and stages; the payment stage only for money roles.
- **Dispatch**: plant_manager/owner plan truck+driver (`saveDispatch`); office_sales reads `/dispatch/office`; the driver app receives the plan and instructions (D135).
- **Approvals inbox** `/approvals` with notification `approval_pending` for owner/app_admin on price, credit and disclosure rows (`0089_notifications.sql:119–135`); `document_request` → `/approvals` (`0091…:117`).
- **Notifications by alert rule** (`0089…:95–113`): cheque bounced, receivables, payables, stock low/shortage, day conflict, with the roles above. Plus `receipt_late/rejected/variance`, `transfer`, `cancel_do_not_load`, `order_cancelled`, `loss_recorded` (catalogue `notification-catalogue.ts:7–31`).
- **Receipts**: plant arrival confirmation, then office_purchases (D133).
- **Day close**: plant_manager closes; blocking items notify owner/app_admin only (`0094_plant_flows.sql:232–236`).
- **Reorder drafts** `/stock/projection` (`stock.read` → plant_manager, owner, app_admin): "a draft purchase for the owner to review… Nothing is ordered" (`reorder-service.ts` header).
- **Disclosure** (§16.3): `disclosure.request` (office, plant_manager) / `disclosure.decide` (owner, app_admin) for ONE figure, scoped and audited (perm.ts:200–201).

Missing:
- **plant_manager → office_purchases reorder request**: no request object; office_purchases has no stock or projection screen, only the STOCK-LOW notification link `/alerts` (a route with no list page: `src/app/[locale]/(protected)/alerts/` holds only `[key]/actions.ts`).
- **Purchase chain page** (purchase → receipt → stock → reorder): none; only the sales-side chain exists.
- **Order → invoice → payment visible to office_sales** beyond the chain stages: no order list and no invoice/payment read.
- **Day close → owner** is notification only when blocking; no "day closed" summary for the owner.
- **accountant** receives nothing from any role (no notification, no queue).

## C. Gap table

| # | Ali's answer / direction | Today | Verdict | Decision / gate and implications |
| --- | --- | --- | --- | --- |
| 1 | Payments recorded by owner, office_sales, accountant, app_admin | `instruments.write` = owner, app_admin, office, office_sales, **office_purchases** (perm.ts:166); accountant absent; deposit/clear/bounce stay `instruments.manage` owner/app_admin (perm.ts:168) | **Needs permission change** (add accountant) **and a database change** | D129 (accountant scope, provisional) is superseded by this answer; D128 already has office_sales blind payments and **office_purchases outgoing payments blind** — Ali's answer omits office_purchases: decide keep/remove. The accountant has **no policy-role mapping** (`V1_POLICY_ROLE`, perm.ts:25–30 has only app_admin, office_sales, office_purchases, plant_manager), so RLS/grants and the definer doors for instruments need new policies and tests (D139). Audit: payment writes are already audited; add accountant to the actor lists and the audit/step-up tests. If the accountant records blind (no `instruments.read`) the model is consistent with D81; if it must see payments it is a new money read |
| 2 | Price confirmed by owner, office_sales, app_admin | `approvals.decide` / confirm = owner, app_admin only (perm.ts:173–174; `confirmPricesInBulk`) | **Needs permission change + conflicts with D130 and D132** (owner or app_admin confirm, step-up, one inbox) | A person who confirms a price must read it: `approvals.read` and the price cards are MONEY_READ, so office_sales would gain a money read on provisional prices (breaks D81/D128 blindness). Needs a new decision, step-up for office_sales, door changes in SQL, audit of who confirmed, and tests (profit counts confirmed prices only, D130) |
| 3 | office_sales sees the official selling price; owner decides per change whether and how it is shown | **Partly true**: `reference_prices.read` includes office_sales (perm.ts:206); the price list (`selling_prices.read`, perm.ts:105) is MONEY_READ only | **Needs permission change + new screen/feature** | Per-change visibility and a "price changed" flag do not exist; the nearest mechanism is the disclosure request (perm.ts:200–201). Conflicts with D81/D128 only for the price list. Audit: every reveal must be logged like a disclosure |
| 4 | plant_manager: no payment relation; works on stock; reorder requests to office_purchases; splits loads | **Already true** for payments (no money keys, `purchases.read` is quantities, perm.ts:232). Stock, dispatch, split of loads exist (`dispatch.write`) | Reorder request: **needs new screen + permission** (office_purchases lacks `stock.read`, perm.ts:341) | D133 defines thresholds and receipts, not a request. New object plant_manager → office_purchases with a notification; no amounts shown to the plant manager |
| 5 | Each account its own home | One home, variants by data (`page.tsx:41–48`) | **Needs new screen** (per-role home blocks) | no decision blocks it |
| 6 | Visible links between accounts | `/orders/chain` for sales side only | **Needs new screen** (purchase chain, payment stage for office_sales) | D81: payment stage stays hidden from non-money roles unless Q1–Q3 decisions change it |
| 7 | Owner/admin/office UI badly organised | 59 links in 7 groups, owner and app_admin identical (`nav-model.ts`) | **Needs new screen** (IA) | none |

Any change to who sees or writes money touches D81, D126–D130, D132, D139 and the real-data gates G2 (roles and privacy) and G9; none should be done without a numbered decision and the RLS visibility matrix tests (`visibility-matrix.test.ts`). Gates stay open; none is affected by this analysis.

## D. The finance "This page couldn't load" (digest 3354622944)

Identified from code, not reproduced. On training staging a **password-only account that has not enrolled an authenticator is treated as signed in** (`session-gate.ts:73–80`, training mode + training e-mail). The layout then shows the Finance link (`(protected)/layout.tsx:30–35`, only `canFinance`, env flag and DB switch) and `finance/page.tsx` passes its own gate (role, `FINANCE_ENABLED`, `financeEnabled`), then calls `getFinanceReport` → `financeRequest`, which does `throw new FinanceUnavailable()` when `!actor.twoFactorEnabled` (`finance/service/request.ts:23`). The page does not catch it, so Next shows the generic 500. The same throw would come out of `getFinanceCash`/`getFinanceReferences`. The seed itself calls finance with `twoFactorEnabled: true` forced (`scripts/seed-training.ts:8b`), which is why the seed works.
- Fix on staging: **enrol the owner's authenticator** (guide §13), then reload `/fr/finance`.
- Code fix (not done): catch `FinanceUnavailable` in the page and show a "sign in with your authenticator" message or `notFound()`, and hide the Finance link for sessions without 2FA.
- If the owner **was** enrolled, the log line needed is the server stderr line carrying digest 3354622944 (`./scripts/staging/dc.sh logs --since 1h app`), which names the thrown error (`FINANCE_UNAVAILABLE`, `STEP_UP_REQUIRED`, or a SQL error). A disabled database switch gives 404, not 500 (`finance/page.tsx:34–40`; missing schema is mapped to "off" by `financeEnabled`).

## E. Proposed information architecture (PROPOSAL, for a prototype only)

Menu reduced to 5–7 entries per role, home blocks as cards with one action each.

| Role | Home blocks | Main menu |
| --- | --- | --- |
| owner | to approve (prices, credit, disclosures); cash and due today; day closes; alerts; orders today | À valider · Ventes · Achats · Stock & production · Trésorerie · Réglages |
| app_admin | same as owner + users, field accounts, parameters shortcuts | owner menu + Administration |
| office_sales | my orders today; to invoice; payments to record; clients owing (flag only); price changes visible to me | Commandes · Devis · Facturer · Paiements · Clients · Suivi livraisons |
| office_purchases | reorder requests from plants; purchases in progress; receipts waiting; supplier invoices to enter; payments to record | Demandes de réappro · Achats · Réceptions · Factures fournisseur · Paiements |
| plant_manager | loads today per truck; split loads; stock below threshold; receipts to confirm; day close; reorder request button | Aujourd'hui · Dispatch · Stock · Réceptions · Clôture |
| accountant | invoices and avoirs of the period; payments to record (if Q1 confirmed); export | Factures · Paiements · Export · Documents |
| driver, pump_operator | unchanged phone app | — |

Cross-links to show on each card: order → dispatch → driver → BL → invoice → payment (sales); purchase → receipt → stock → reorder → purchase (purchases); plant day close → owner. Questions to confirm with the owner before design: office_purchases payments (keep/remove), whether the accountant records payments blind or reads them, whether price confirmation by office_sales needs step-up and what it sees, and who receives "price changed" flags.
