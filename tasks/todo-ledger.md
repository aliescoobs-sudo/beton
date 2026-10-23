# Task list: `ledger`

Plan: [tasks/plan-ledger.md](plan-ledger.md) (**approved**; build phase by phase). Standard verification for every task: `pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm test:integration` when it touches the DB, `SIMULATION_ENABLED=false pnpm build` and `pnpm exec playwright test` when it adds a route or screen). One commit per task. Every new table: `TABLE_ACCESS` entry (+ `insertOnly`, `noDelete`), matrix fixture, FORCE RLS, audit trigger, no UPDATE/DELETE grant. Migrations create structure only. Checkpoint review with Ali after L5 (CP-L1) before L8 / L17 / L20.

## Phase 0: Foundations and the financial pattern

### - [x] L0: Money visibility foundation (DECISIONS 81, provisional) (M)
New role `support` (read-only everywhere, 2FA, audited money views, disabled by the owner); partner and office lose every money read; only the owner writes prices. Migration 0030: role check, `view` audit action, `public.grant_support_read()` + a `support_read` policy on every table, `audit.is_money_table()` hiding money audit rows (they hold amounts) from partner/office/plant, price policies owner-only. `money: true` flag in `TABLE_ACCESS`; every later ledger table must set it and call `grant_support_read` and extend `audit.is_money_table`.
**AC:** `tests/money-visibility.int.test.ts` (zero rows for partner/office/plant/system/anonymous on every money table, support read-only, audit rows hidden, views audited, disabled support refused), permission matrix tests, e2e for support/partner/office on the price screens.

### - [ ] L1: Money domain, parameters, shared request helpers (M)
Pure `ledger/domain`: `computeTotals(volumeL, unitPriceHtPerM3, vatBp)` via `mulDivRound`, `splitPlan(totalTtc, items)` (percent or fixed amounts; the last item absorbs rounding), `isPostDated`, legal constants (`REGULARIZATION_WINDOW_DAYS = 30`, law 71.24; `MAX_PAYMENT_DAYS = 120`, `DEFAULT_PAYMENT_DAYS = 60`, law 69-21). Register `vat_rate_bp` (default 2000, bounds per Q8), `reversal_window_days` (2), `clearing_delay_days` (1) in `PARAMETERS`. Lift `inRequest`/`require`/`isUniqueViolation`/`isMalformedId` to the `platform-security` public surface (master-data re-imports them). Implement the `Centimes` arithmetic guard as helpers (`addCentimes`/`subCentimes`/`sumCentimes`) in `lib/money.ts` plus a scan test (Ali accepted the fallback, no typed ESLint rule).
**AC:** AC-LED-01 (domain: 120 m³ × 780,00 → 93 600,00 / 18 720,00 / 112 320,00; 20/40/40 → 22 464,00 / 44 928,00 / 44 928,00), AC-LED-02 (domain: Σ ≠ TTC is `Err`), AC-LED-11 (helpers + scan test, red test first), AC-LED-13 (grep test: no literal rate in `ledger/domain`). fast-check: for any amounts and splits Σ items = TTC exactly.
**Verify:** `pnpm test src/modules/ledger src/lib src/modules/platform-security` · **Files:** ledger/domain/{totals,plan,instrument-dates,legal}.ts + tests, platform-security/domain/parameters.ts, platform-security/index.ts, master-data/service/request.ts, eslint config · **Deps:** none

### - [ ] L2: Yearly document counters (S)
Migration `doc_sequence (prefix, year, last_value)`, FORCE RLS, audit; `public.next_doc_number(prefix, year, width)` (row-locked, a rolled-back transaction returns its number); `TABLE_ACCESS`, matrix fixture; domain `formatDocNumber`.
**AC:** AC-LED-08 (counter part: 10 parallel calls → 10 consecutive numbers; gapless after a rollback; a new year restarts at 1); office/plant cannot write the table directly.
**Verify:** `pnpm test:integration doc-sequence rls` · **Files:** migration, ledger/service/doc-number.ts, tests · **Deps:** L1

### - [ ] L3: Order + payment plan, create (service + DB) (M)
Migration `order`, `payment_plan_item` (insert-only, `reverses_id`, direction in/out): code `CMD-YYYY-nnnnn`, client/site/zone/type, `volume_l`, `delivery_date`, price from `resolveSellingPrice` (stored `selling_price_id` + `unit_price_ht_centimes`), `vat_rate_bp` copied from the parameter at creation, totals stored with `CHECK total_ttc = total_ht + total_vat`, `brought_by_user_id`. Deferred constraint trigger: Σ plan items = order TTC. `createOrder` service: presets (comptant, 50% avance + 50% livraison, 3 échéances 30/60/90, chèque à 30 j, custom) via `splitPlan`; archived client/site refused; office W, plant column-level SELECT only (no price/total/plan).
**AC:** AC-LED-01, AC-LED-02 (service + DB trigger), AC-LED-13 (VAT 1400 only affects later orders), AC-LED-18 (archived client refused on a new order, old orders still show it), AC-SEC-04 for `order`, `payment_plan_item` × 4 roles.
**Verify:** `pnpm test:integration order rls` · **Files:** migration, ledger/service/order-service.ts, ledger/db queries, index.ts, table-access.ts, matrix fixture, tests/order.int.test.ts · **Deps:** L1, L2

### - [ ] L4: Order entry screen (M)
One-screen form in fr/ar: client search by name/code, site, type, m³ (litres stored), date, resolved price prefilled, plan presets, live totals from the domain function, `bdi`/`dir=ltr` for codes and amounts, i18n keys under `ledger.orders`. Nav entry filtered by `orders.write`.
**AC:** AC-LED-10 (timed Playwright script: office user, 2-item plan, < 120 s without AI; result in `docs/pilot/entry-timing.md`), form shows amounts that equal the service's; AC-MD-09 style RTL check for the screen.
**Verify:** `pnpm exec playwright test e2e/ledger-order.spec.ts` · **Files:** app/[locale]/(protected)/orders/new/page.tsx, ledger/ui/orders/*, messages, e2e/ledger-order.spec.ts · **Deps:** L3

### - [ ] L5: Reversal pattern: cancel an order (M)
`cancelOrder(orderId, reason)`: inserts a reversing `order` row and negated `payment_plan_item` rows (`reverses_id`), optional replacement order in the same transaction, mandatory reason, one audit event with the reason. A reversal cannot be reversed, an order cannot be reversed twice (unique `reverses_id`). Reversal window: office within `reversal_window_days`, older needs `ledger.reverse_old`. Derived `is_reversed` in reads. Meta-test: no UPDATE/DELETE/TRUNCATE grant on `order`, `payment_plan_item`.
**AC:** AC-LED-03 (orders: no DELETE path, cancel = reversing row + audited reason), AC-LED-17 (office ≤ 2 days ok, older refused, owner/partner ok).
**Verify:** `pnpm test:integration order-reversal rls` + e2e cancel from the order screen · **Files:** migration (unique reverses_id), ledger/service/order-service.ts, ledger/ui/orders/cancel-order.tsx, tests · **Deps:** L3 (L4 for the button)

### Checkpoint CP-L1: Pattern
- [ ] L1–L5 green; insert-only + reversal + DB invariants + visibility reviewed with Ali before the pattern is copied
- [ ] `Centimes` helpers and scan test in place; the plan's decisions 1–10 applied

## Phase 1: Orders complete

### - [ ] L6: Price override on a single order (S)
Order creation accepts a unit price different from the resolved one only for `orders.price_override` (owner/partner), with a mandatory reason stored on the order; DB `CHECK (unit_price_ht_centimes = resolved OR reason IS NOT NULL)` style guard plus RLS `WITH CHECK`; office can only use the resolved price; UI field shown to managers only.
**AC:** AC-LED-12 (office refused by service and by direct SQL under RLS; owner/partner without reason refused; with reason saved and audited).
**Verify:** `pnpm test:integration order-price-override` · **Files:** migration, order-service.ts, order form, tests · **Deps:** L3

### - [ ] L7: Order list/detail, plant projection, plan-item state (M)
Order list and detail (office/managers: plan, state of each échéance: `pending/covered/partially_covered/overdue/cancelled` derived from allocations + `clock.today()`; covered amounts arrive with L11, until then pending/overdue); plant read path via the column grants: code, type, volume, delivery date, site/zone only. `project()` entry for `order`.
**AC:** AC-SEC-05 (order part: plant response has no price, total, payment plan or client contact: `expectNoFields` on service output and rendered HTML), AC-SEC-04 matrix, derived-state unit tests (overdue when due_date < today and not covered).
**Verify:** `pnpm test:integration order-visibility` + e2e · **Files:** ledger/domain/plan-state.ts, order-service.ts (list/get), pages, ui, tests · **Deps:** L3 (L11 later feeds covered)

### Checkpoint CP-L2: Orders
- [ ] AC-LED-01, 02, 03 (orders), 10, 12, 13, 17, 18 and AC-SEC-05 order part green; both locales render

## Phase 2: Instruments and money

### - [ ] L8: Money accounts and opening balances (S)
Migration `money_account` (caisse/bank), `opening_balance`; owner/partner read and write, office and plant none; nav and screen for owners; accounts come from the pilot seed (L24), not the migration.
**AC:** AC-SEC-04 for both tables × 4 roles (office: no read); opening balance insert-only; OQ9 values are fake.
**Verify:** `pnpm test:integration money-account rls` · **Files:** migration, ledger/service/money-account-service.ts, ui, tests · **Deps:** L1

### - [ ] L9: Instrument state machine (domain) (S)
Pure `nextState(direction, method, state, event)`: incoming `received → deposited → cleared | bounced`, `bounced → regularized | disputed`, outgoing `issued → cleared | bounced`, cash/transfer `received|issued → cleared` same day, any non-final → `cancelled`. `regularizationDeadline(bouncedDate) = +30 days`. fast-check: every pair not in the table is rejected.
**AC:** AC-LED-04 (domain: `cleared → bounced`, cheque `received → cleared` without deposit rejected).
**Verify:** `pnpm test src/modules/ledger/domain` · **Files:** ledger/domain/instrument.ts + test · **Deps:** L1

### - [ ] L10: Instruments, events, `cleared` → movement (M)
Migration `payment_instrument`, `instrument_event` (append-only), `money_movement` (insert-only, `reverses_id`, `UNIQUE (source, source_id)`). Guard trigger on `instrument_event` enforces the L9 table; `SECURITY DEFINER` trigger on `cleared` writes exactly one signed movement (incoming +, outgoing −) and maintains the cached `status` (no UPDATE grant); office can receive/issue/clear without ever reading `money_movement`. Services: `receiveInstrument` (cash = received + cleared same day into the caisse), `issueInstrument`, `clearInstrument`, `cancelInstrument` (reversing entry, reason, window rule).
**AC:** AC-LED-04 (illegal transitions rejected by the service and by direct SQL; `cleared` = exactly one movement with the right sign), AC-LED-03 (instruments, events, movements), AC-SEC-04/05 (office reads instruments, not movements).
**Verify:** `pnpm test:integration instrument rls` · **Files:** migration, ledger/service/instrument-service.ts, tests/instrument.int.test.ts, table-access.ts, matrix · **Deps:** L8, L9

### - [ ] L11: Allocations: instruments cover plan items (M)
Migration `allocation` (insert-only; reversal = negated row). Trigger (advisory lock) keeps Σ per instrument ≤ instrument amount and Σ per item ≤ item amount. `allocate`/`unallocate`; plan-item state now uses allocations (`covered`, `partially_covered`); one instrument covers several items and vice versa.
**AC:** property test: Σ allocations never exceed either side under 10 parallel allocations; covered state correct; AC-SEC-04.
**Verify:** `pnpm test:integration allocation rls` · **Files:** migration, ledger/service/allocation-service.ts, plan-state.ts, tests · **Deps:** L3, L10

### - [ ] L12: Deposit batch and early presentation (S)
"Remise en banque": deposit a selection of received cheques/LCN to a bank account on a date; allowed before `written_date` (post-dated presented early), event flagged `early` (derived `at_date < written_date`); outgoing post-dated cheques can be cleared before their written date.
**AC:** AC-LED-14 (early deposit/clearing allowed and flagged; not flagged when on or after the written date), AC-LED-04 (one batch = one event per instrument).
**Verify:** `pnpm test:integration deposit` · **Files:** instrument-service.ts, domain early flag, tests · **Deps:** L10

### - [ ] L13: Bounce, 30-day window, regularize, dispute (M)
`bounceInstrument` sets `regularization_deadline = bounced_date + 30`, reverses its allocations (items uncovered, overdue if past due), optional bank-fee `money_movement(source='expense')` (owner/partner, Q5). `regularizeInstrument` requires a new covering instrument (cash/transfer/cheque) and closes the window; `disputeInstrument` closes it and flags the client. A bounced instrument stays in history next to the new one.
**AC:** AC-LED-05 (cheque from CLT-08 bounced on D3 → deadline D3+30, items un-covered, overdue if past due), AC-LED-06 (regularize needs a covering instrument, window closes, history shows both).
**Verify:** `pnpm test:integration bounce regularize` · **Files:** instrument-service.ts, domain, tests · **Deps:** L11, L12

### - [ ] L14: Instruments screens: receive and list (M)
Receive cash/cheque/LCN/transfer against an order's échéances (amount, number, bank, issue/written date, allocation), list with status, early/post-dated badges and the regularization countdown; fr/ar, Latin numbers in LTR.
**AC:** receive + allocate in the UI updates the plan-item state; AC-MD-09 style RTL check; office sees no balance or cash total on the screen.
**Verify:** `pnpm exec playwright test e2e/ledger-instrument.spec.ts` · **Files:** pages, ledger/ui/instruments/*, messages, e2e · **Deps:** L11

### - [ ] L15: Instruments screens: lifecycle actions (M)
Deposit batch, clear, bounce (with window), regularize, dispute, cancel (reason), each with confirmation and step-up where the permission list requires it; error states for illegal transitions.
**AC:** AC-LED-05/06 through the UI in fr and ar; reversal window applies to the cancel button.
**Verify:** `pnpm exec playwright test e2e/ledger-lifecycle.spec.ts` · **Files:** ui/instruments/*, actions.ts, messages, e2e · **Deps:** L12, L13, L14

### - [ ] L16: Encaissé vs total view (S)
`getCashPosition(accountId?)` (permission `cash.read`, owner/partner): real = Σ cleared movements + opening balance; total incl. uncleared = real + incoming instruments `received`/`deposited`; also outgoing issued not yet cleared; per account and in total; owner screen.
**AC:** AC-LED-07; AC-SEC-05 (office refused by service, RLS and page 404; `expectNoFields` on office responses).
**Verify:** `pnpm test:integration cash-position` + e2e · **Files:** ledger/domain/cash-position.ts, service, page, tests · **Deps:** L10

### Checkpoint CP-L3: Instruments
- [ ] AC-LED-03 (instruments), 04, 05, 06, 07, 14 green; office cannot read money tables; both locales render

## Phase 3: Invoices (law 69-21)

### - [ ] L17: Invoice with gapless number and legal dates (M)
Migration `invoice`, `invoice_line` (insert-only; `delivery_id` nullable, no FK, Q2). `createInvoice` from an order: number `FA-YYYY-nnnnn` via L2, `ice_client` and `vat_rate_bp` copied at creation, due date default invoice date + client terms (60 by default), > 120 refused, issuance deadline = last day of the delivery month (domain `invoiceIssueDeadline`).
**AC:** AC-LED-08 (10 parallel creations → 10 consecutive numbers), AC-LED-09 (default +60, > 120 rejected), AC-LED-15 (deadline), AC-LED-11 (integer columns), AC-SEC-04.
**Verify:** `pnpm test:integration invoice rls` · **Files:** migration, ledger/domain/legal.ts, service/invoice-service.ts, tests · **Deps:** L2, L3

### - [ ] L18: Credit note and invoice screen (M)
`cancelInvoice` creates a credit note (`credit_note_of`, negated lines), number never reused, reason mandatory; invoice list/detail/printable view in fr/ar with ICE, VAT rate and amounts; status `issued/paid/partially_paid/cancelled` derived from allocations.
**AC:** AC-LED-08 (cancelled invoice keeps its number, credit note issued), AC-LED-03 (invoices), RTL check.
**Verify:** `pnpm test:integration invoice-credit-note` + e2e · **Files:** invoice-service.ts, pages, ui, messages · **Deps:** L17

### - [ ] L19: Legal deadlines read model (S)
Derived (not stored) `legalDeadlines(asOf)` for both directions: receivable due dates and issuance deadlines, payable due dates (purchases come in L20); consumed later by rules-engine alerts.
**AC:** AC-LED-15 (invoice issuance deadline = last day of the delivery month; due dates both directions); no alert logic here.
**Verify:** `pnpm test src/modules/ledger/domain` + integration · **Files:** domain/legal.ts, service/deadlines.ts, tests · **Deps:** L17

## Phase 4: Purchases and supplier payments

### - [ ] L20: Purchase + plan items (out) (M)
Migration `purchase`, `purchase_line` (insert-only, reversal): code `ACH-YYYY-nnnnn`, supplier, supplier invoice no/date, due date 69-21 (default +60, ≤ 120), VAT rate stored, totals via domain, plan items direction `out` (Σ = TTC), lines may be services (transport, fuel) without component; archived supplier refused. Office W; plant reads receipt lines only.
**AC:** AC-LED-16 (due date rules), AC-LED-02 (plan Σ = TTC), AC-LED-18 (archived supplier), AC-LED-03 (purchases), AC-SEC-04.
**Verify:** `pnpm test:integration purchase rls` · **Files:** migration, service/purchase-service.ts, tests · **Deps:** L1, L2

### - [ ] L21: Purchase receipt (S)
Migration `purchase_receipt` (insert-only): `recordReceipt(purchaseId, date)` by plant/office; no price or total visible to plant (`expectNoFields`); emits the fact `operations` will turn into a stock increase (R2); no stock logic here.
**AC:** plant sees quantities only (AC-SEC-05 purchase part); a receipt cannot be recorded twice for the same lines.
**Verify:** `pnpm test:integration purchase-receipt` · **Files:** migration, service, tests · **Deps:** L20

### - [ ] L22: Supplier payments (M)
Outgoing instruments (`issued`, cheque/LCN/transfer/cash) allocated to `out` plan items, reusing L10–L13 with direction `out`: outgoing post-dated cheques counted as liabilities (stored as facts, early clearing allowed and flagged), bounce on outgoing handled as an event.
**AC:** AC-LED-16 (supplier payment allocation), AC-LED-14 (outgoing early clearing), AC-LED-04 for direction `out`.
**Verify:** `pnpm test:integration supplier-payment` · **Files:** instrument-service.ts, allocation-service.ts, tests · **Deps:** L11, L12, L20

### - [ ] L23: Purchases screens (M)
Purchase entry (lines, plan presets), list/detail, receipt and supplier payment actions, fr/ar; office sees documents, no cost analysis or margin.
**AC:** RTL check; plant sees the receipt screen only; AC-SEC-05 purchase part in HTML.
**Verify:** `pnpm exec playwright test e2e/ledger-purchase.spec.ts` · **Files:** pages, ui, messages, e2e · **Deps:** L21, L22

### Checkpoint CP-L4: Invoices and purchases
- [ ] AC-LED-08, 09, 15, 16, 18 green; supplier payment end to end; both locales render

## Phase 5: Close

### - [ ] L24: Pilot ledger seed (S)
Fake data through `belgobeton_seed` (extend `db/seed/seed-role.sql` for the new tables, same rules: SELECT/INSERT only, simulation only): a few orders with plans, instruments in each state (including one bounced inside its window and one post-dated), one invoice, two purchases, 1 caisse + 2 bank accounts with opening balances. Idempotent, audited as `system/seed`, refuses outside simulation; the full fixture stays with `simulation`.
**AC:** idempotent; every row audited as `system/seed`; the meta-test still shows `belgobeton_system` cannot insert ledger rows.
**Verify:** `pnpm test:integration pilot-seed` · **Files:** pilot-seed.ts, db/seed/seed-role.sql, tests · **Deps:** L3, L10, L17, L20

### - [ ] L25: Bilingual screen check for the ledger (S)
Extend the T16 Playwright spec and the i18n tests to every ledger screen (orders, instruments, cash position, invoices, purchases, accounts): direction, no overflow at 375/1280, no missing key, no CSP violation, amounts/numbers/ICE LTR in Arabic, long client names and cheque numbers.
**AC:** AC-MD-09 style check green for all ledger screens; key parity and key-usage tests cover `ledger.*`.
**Verify:** `pnpm exec playwright test e2e/ledger-screens.spec.ts` · **Files:** e2e spec, fixtures · **Deps:** L24

### - [ ] L26: Closure (S)
Fill the AC table with passing tests; `TABLE_ACCESS` covers every new table (`insertOnly` + `noDelete`); AC-SEC-05 ledger part (plant: no price/total/plan/contact; office: no margin, no cash position); AC-LED-03 meta-test over every ledger table; AC-LED-11 and AC-LED-13 checks green; coverage ≥ 90% on `ledger/domain` (`vitest.config.ts` gate); DECISIONS/README update; SPEC-ledger additions (AC-LED-14…18) merged if approved.
**AC:** all AC-LED-01…18 mapped to a passing test.
**Verify:** `pnpm test:coverage`, full pipeline · **Files:** tasks/plan-ledger.md, tests/ledger-visibility.int.test.ts, vitest.config.ts, docs · **Deps:** L25

### Checkpoint CP-L5: Ledger final
- [ ] Full pipeline green; all AC-LED mapped; review with Ali before `operations`
