# Implementation Plan: `ledger`

Status: **APPROVED** (Ali, answers below). Not started: built phase by phase in separate sessions · Task list: [tasks/todo-ledger.md](todo-ledger.md)

Specs: SPEC-ledger.md, CAPABILITY-MAP.md, docs/DOMAIN.md (R6–R12, R24, R25), docs/DECISIONS.md (27–29, 31, 33, 34, 60, 66, 67), SPEC-platform-security §4. Depends on `master-data` (done, CP final) and `clock` (done).
Written to `tasks/plan-ledger.md` / `todo-ledger.md` because `tasks/plan.md` and `tasks/todo.md` still hold the unchecked platform-security work (same convention as master-data).
Standard verification for every task: `pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm test:integration` when it touches the DB, `SIMULATION_ENABLED=false pnpm build` then `pnpm exec playwright test` when it adds a route or screen). One commit per task.

## Overview
The ledger records every money commitment and movement exactly: orders with delivery date and payment plan, payment instruments through their lifecycle (including post-dated cheques and the 30-day regularization window of law 71.24), internal invoices (ICE, VAT rate stored at creation, law 69-21 due dates), purchases and supplier payments, and the caisse/bank accounts. Two views of money always exist: encaissé (real) and total including uncleared. Nothing is ever deleted; corrections are reversing entries. All amounts are integer centimes. Office sees transactions but no margins and no cash position.

## Architecture decisions
1. **SQL-first, structure only** (DECISIONS 43, 79). One hand-written migration per task, typed `pg` queries in `service/`, Zod parsers at the boundary. Fake data only from the pilot seed through `belgobeton_seed` (DECISIONS 80): L24 extends `db/seed/seed-role.sql`; the `system` role is never widened.
2. **Insert-only everywhere, no UPDATE grant on any ledger table.** The spec lets the service "recompute" cached statuses (`instrument.status`, invoice status). Recommendation: keep them correct in the database instead. A `SECURITY DEFINER` trigger on `instrument_event` / `allocation` maintains the cached status, so `belgobeton_app` has no UPDATE at all and a buggy service cannot desynchronise it. (Deviation from SPEC-ledger §2, strictly stronger: needs your OK, Q1.) The `insertOnly` flag in `TABLE_ACCESS` and the meta-test then cover every ledger table.
3. **Invariants live in the database, not only in the service.**
   - Σ payment-plan items = document TTC: deferred constraint trigger (AC-LED-02).
   - Legal instrument transitions: guard trigger on `instrument_event` (AC-LED-04), so an illegal transition cannot be written even by a bug.
   - `cleared` writes exactly one signed `money_movement`: `SECURITY DEFINER` trigger plus `UNIQUE (source, source_id)`.
   - Allocations never exceed the instrument amount nor the item amount (advisory-lock trigger, same style as the price guards).
   - Totals: `CHECK (total_ttc = total_ht + total_vat)`; the VAT amount is re-verified by test against the domain function.
4. **Reversals, never deletes (R12, AC-LED-03).** `reverses_id` on order, payment_plan_item, instrument, purchase, money_movement, allocation; a reversal row carries negated amounts and a mandatory reason; both rows are audited. Reversal of an entry older than `reversal_window_days` (parameter, 2) needs `ledger.reverse_old` (owner/partner); office has `ledger.reverse`. A reversed original is excluded by a derived `is_reversed`, never edited.
5. **Visibility by tables and columns, then fields.**
   - `money_account`, `money_movement`, `opening_balance`: owner/partner only (office sees no cash position, A9). Office still clears cash: the `cleared` trigger writes the movement for it.
   - Plant has no access to money tables, and only a column-level SELECT grant on `order` (code, concrete type, volume, delivery date, site/zone: no price, total, plan or client contact; AC-SEC-05). `expectNoFields` asserts it on service output and rendered HTML.
   - No margin or cost column exists on any ledger table; margin is computed in `operations`/`rules-engine`.
   - `cash.read` / `margins.read` (owner/partner) already exist in `PERMISSIONS`; the encaissé-vs-total service requires `cash.read`.
6. **Pure domain first**: `computeTotals`, `splitPlan` (last item absorbs rounding), instrument state machine, `regularizationDeadline`, `isPostDated`, legal due dates, plan-item state. No I/O, no `Date.now()`; time comes from `clock.today()`. Property-tested with fast-check; ≥ 90% coverage gate on `ledger/domain` (same as master-data).
7. **Money**: `bigint` centimes in the DB, `Centimes` in TS; the only fraction is `mulDivRound` (VAT = `mulDivRound(ht, vat_rate_bp, 10000)`). AC-LED-11 needs a lint rule forbidding `+ - * /` on `Centimes` outside `lib/money.ts` (typed ESLint rule; fallback if infeasible: add `addCentimes/sumCentimes` helpers plus a scan test; see risks).
8. **VAT and parameters**: `vat_rate_bp`, `reversal_window_days`, `clearing_delay_days` are added to `PARAMETERS` (owner-only writes, bounded). Each order/invoice/purchase stores the VAT rate in force at creation. No literal rate in domain code (grep test, AC-LED-13). The 30-day window of law 71.24 is a named legal constant with the law cited, not a parameter.
9. **Codes**: `CMD-YYYY-nnnnn`, `ACH-YYYY-nnnnn`, `FA-YYYY-nnnnn` from a per-(prefix, year) counter row locked in the creating transaction (L2), year taken from the business date. Invoice numbers are gapless: a rolled-back transaction returns its number; a cancelled invoice keeps its number and gets a credit note.
10. **Plan-item method vs instrument method.** A plan item says how we expect to be paid (`cash/cheque/lcn/transfer/advance/installment`); an instrument is what actually arrived (`cash/cheque/lcn/transfer`). `advance` and `installment` are plan-item labels covered by any instrument via `allocation`. One instrument can cover several items and vice versa.
11. **Post-dated cheques can be presented early (R11, D29).** Deposit (incoming) and clearing (outgoing) are allowed before `written_date`; the event is flagged `early` (derived: `at_date < written_date`) and shown with a warning. The ledger stores the facts; the rules engine decides what they mean for the forecast. (New AC-LED-14.)
12. **Law 69-21 (R24)** is dates only in the ledger: default due date = document date + 60 days, > 120 refused, invoice issuance deadline = last day of the delivery month. The ledger exposes a derived read model of legal deadlines (both directions); alerts are `rules-engine`.
13. **Boundaries**: `ledger` imports `master-data`, `clock` and (transitively) `platform-security`. `inRequest`/`require` currently live inside `master-data/service/request.ts`. L1 lifts them to the `platform-security` public surface instead of copying a security-critical helper (Q6).
14. **UI**: same kit as master-data; strings in `messages/{fr,ar}.json` under `ledger.*`; financial terms stay French in both locales (D48); logical Tailwind properties only; Latin codes, ICE, cheque/LCN numbers and amounts in `dir="ltr"` / `<bdi>`; screens covered by the T16-style bilingual check (L25).
15. **What the ledger does not do**: deliveries, stock effects of receipts (operations), forecast, account colours, alerts, option generator (rules-engine), AI-assisted entry (ai-layer; it only prefills the same form). Invoice lines reference `delivery_id` without a foreign key until `operations` adds it (Q2).

## Dependency graph
```
L1 domain (vat, splitPlan, params, request helpers lifted) ─ L2 yearly counters
L1,L2 ─ L3 order + plan (service + DB)  ─ L4 order entry screen ─ L5 reversal pattern (cancel order)   ◄── CP-L1 pattern
L3 ─ L6 price override on one order ─ L7 order list/detail + plant projection + plan-item state          ◄── CP-L2 orders
L1 ─ L8 money accounts + opening balances
L8 ─ L9 instrument state machine (domain) ─ L10 instrument + events + cleared→movement trigger
L3,L10 ─ L11 allocations (cover plan items)
L10 ─ L12 deposit batch + early presentation ─ L13 bounce + 30-day window + regularize/dispute (+ bank fee)
L11,L12,L13 ─ L14 instruments screens (receive, list) ─ L15 lifecycle screens                            ◄── CP-L3 instruments
L10 ─ L16 encaissé vs total (cash.read)
L3,L2 ─ L17 invoice + gapless number + 69-21 dates ─ L18 credit note + invoice screen ─ L19 legal deadlines read model
L1,L2 ─ L20 purchase + plan (out) ─ L21 receipt ─ L22 supplier payments (reuses L10–L13, direction out) ─ L23 purchases screens   ◄── CP-L4
L3,L10,L17,L20 ─ L24 pilot seed ─ L25 bilingual check ─ L26 closure                                       ◄── CP-L5
```
Parallelisable after CP-L1: {L6, L7} ∥ {L8, L9}; after L10: {L11…L15} ∥ {L16}; {L17…L19} ∥ {L20…L23} (shared only through L1/L2).

## Checkpoints
| Phase | Tasks | Checkpoint |
|---|---|---|
| 0 Pattern | L1–L5 | **CP-L1**: the financial pattern (insert-only + reversal + DB invariants + visibility) reviewed with Ali before it is copied to instruments, invoices, purchases |
| 1 Orders | L6–L7 | CP-L2: AC-LED-01, 02, 03 (orders), 12, 13, AC-MD-05 order part |
| 2 Instruments | L8–L16 | CP-L3: AC-LED-03 (instruments), 04, 05, 06, 07, 14 |
| 3 Invoices | L17–L19 | CP-L4a: AC-LED-08, 09, 15 |
| 4 Purchases | L20–L23 | CP-L4: AC-LED-16 and supplier payments end to end |
| 5 Close | L24–L26 | CP-L5: all AC-LED-01…18, AC-SEC-04/05 for these tables, coverage ≥ 90% on `ledger/domain` |

## AC coverage
Spec ACs 01–13; 14–18 are **proposed additions** (SPEC-ledger is not edited until you approve them, Q7).

| AC | Statement (short) | Tasks |
|---|---|---|
| AC-LED-01 | 120 m³ B25 example; Σ items = TTC (property) | L1, L3 |
| AC-LED-02 | Plan Σ ≠ TTC rejected | L1, L3 (DB trigger) |
| AC-LED-03 | No DELETE anywhere; cancel = reversing row + audited reason | L5, L10, L17, L20, L26 |
| AC-LED-04 | Illegal transitions rejected; `cleared` = one movement, right sign | L9, L10 |
| AC-LED-05 | Bounce on D3 → deadline D3+30, un-cover, overdue if past due | L13 |
| AC-LED-06 | Regularize needs a covering instrument; window closes | L13 |
| AC-LED-07 | Real cash vs total incl. uncleared, per account and total | L16 |
| AC-LED-08 | Gapless invoice numbers under concurrency; credit note keeps number | L2, L17, L18 |
| AC-LED-09 | Invoice due date +60 days default; > 120 refused | L17 |
| AC-LED-10 | Office enters a 2-item order in < 120 s (timed e2e) | L4 |
| AC-LED-11 | Integer columns; no `number` arithmetic on `Centimes` outside `lib/money.ts` | L1 (rule), L26 (check) |
| AC-LED-12 | Office price change refused; owner/partner needs a reason | L6 |
| AC-LED-13 | `vat_rate_bp` change affects only later orders; no literal rate | L1, L3 |
| AC-LED-14 *(new)* | Post-dated cheque deposited/cleared before `written_date`: allowed, flagged `early` | L12, L22 |
| AC-LED-15 *(new)* | Invoice issuance deadline = last day of delivery month; legal-deadline read model both directions | L17, L19 |
| AC-LED-16 *(new)* | Purchase due date default +60, > 120 refused; supplier payment allocation | L20, L22 |
| AC-LED-17 *(new)* | Reversal window: office ≤ 2 days ok, older refused, owner/partner ok | L5 |
| AC-LED-18 *(new)* | Archived client/supplier not selectable on a new order/purchase; existing documents still show it (closes AC-MD-05) | L3, L20 |
| AC-SEC-04 (ledger) | RLS matrix per table × role | each table task, L26 |
| AC-SEC-05 (ledger) | Plant: no price/total/plan/contact; office: no margin, no cash position | L7, L16, L26 |

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Financial pattern copied 4× with a flaw | High | L1–L5 first, CP-L1 review before L8 and L17/L20 |
| Lifecycle or `cleared`→movement logic only in the service | High | DB guard + definer trigger + unique key (decision 3); tests write illegal rows directly under RLS |
| Concurrent allocations over-cover an item or instrument | High | advisory-lock trigger + 10-parallel test |
| Gapless invoice numbers broken by a rollback or a retry | High | counter row locked in the creating transaction; 10-parallel test (AC-LED-08) |
| Office learns the cash position through a join or an aggregate | High | no read grant on money tables for office; `expectNoFields` on every office-facing response; matrix test |
| AC-LED-11 "lint forbids arithmetic on `Centimes`" is not expressible with plain ESLint | Med | typed custom rule in L1; fallback `sum/add/sub` helpers + scan test; decide in L1, report at CP-L1 |
| Ledger is large (26 tasks vs 17 for master-data) | Med | five checkpoints; phases 3 and 4 are independent and can be split into a `ledger-2` plan if you prefer |
| Invoice lines need deliveries that do not exist yet | Med | nullable `delivery_id`, FK added by `operations` (Q2) |
| Rounding drift between plan split and totals | Med | one `mulDivRound`, last item absorbs, property test |
| Arabic/RTL regressions on dense financial screens | Med | L25 bilingual check, key-parity test, `bdi`/`dir=ltr` for codes and amounts |
| Reversal chains (reverse a reversal) create ambiguity | Low | a reversal cannot itself be reversed; a mistake is fixed by a new entry (decision 4) |

## Decisions (Ali)
1. Cached statuses are kept by `SECURITY DEFINER` triggers; `belgobeton_app` has no UPDATE on any ledger table.
2. Invoices are built before `operations`, with a nullable `delivery_id`; the FK is added later by `operations`.
3. Plant sees client code, site label and zone only: no name, contact, price or total.
4. A cleared instrument entered by mistake is corrected by a reversing `money_movement`, owner/partner only, mandatory reason, audited.
5. The bounced-cheque bank fee is a `money_movement` with source `expense`, owner/partner only.
6. `inRequest` / `require` (and the error helpers) are lifted to the `platform-security` public surface (L1).
7. AC-LED-14…18 are added to SPEC-ledger.md.
8. `vat_rate_bp` is bounded 0–2500 (default 2000), owner-only writes.
9. One ledger plan, built phase by phase in separate sessions.
10. AC-LED-11: the fallback is accepted (`addCentimes`/`subCentimes`/`sumCentimes` helpers in `lib/money.ts` plus a scan test that flags `+ - * /` on `Centimes` elsewhere); no typed ESLint rule.

## Money visibility (DECISIONS 81, provisional until the owner confirms on 2026-10-24)
Answers (2026-10-23): A server-side price for office; B correction requests replace office reversals; D partner = plant-style projection of orders; E build L0 then L1–L5 and stop at CP-L1.
11. Roles: `support` is added (read-only everywhere, 2FA, audited views); `partner` loses every money permission; `office` is write-only on money (**blind entry**); `plant` unchanged. `cash.read`, `margins.read`, `purchase_prices.*`, `selling_prices.*`, `client_price_override.write`, `orders.price_override`, `reconciliation`-money views, `ai.qa` become owner + support (writes: owner only).
12. Plan items 5 and 14 change: money tables (`order` totals, `payment_plan_item`, `payment_instrument`, `instrument_event`, `money_movement`, `money_account`, `opening_balance`, `allocation`, `invoice*`, `purchase*`, price tables) give office INSERT only, no SELECT, and partner/plant nothing; plant keeps only the operational column grant on `order`. A write returns no amount.
13. Tasks that change: L4 (no live totals or prefilled price for office; answered: server-side price), L5/L10/L13/L15/L18 (office cannot reverse, cancel, bounce, regularize: it files a correction request, answered: correction request), L6 (owner only), L7 (office has no list or detail; answered: partner gets the plant-style projection), L8/L16 (owner + support), L14 (receive form only, no list), L17/L20/L23 (create only for office). AC-LED-10, 12, 17 and AC-SEC-05 are reworded; new AC: zero rows for office, plant and partner from every money table and view (matrix test), support has no write path, support views audited.
14. Existing master-data to tighten in the first migration: purchase_price, selling_price, selling_price_override (migrations 0024–0026) and their screens, services and tests (partner write, office read).
15. Phase naming: the task list has Phase 0 (L1–L5, ends at CP-L1) and Phase 1 (L6–L7, which needs L3). Nothing is built yet. Answered: "phase 1" = L1–L5, stop at CP-L1; a new task **L0 (money visibility foundation)** is built first.
