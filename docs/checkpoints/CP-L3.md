# CP-L3: instruments, owner money views, statements

Reviewed by: nobody yet (the owner asked to continue while everything is green). Everything below is committed and passed the full pipeline (lint, prettier, typecheck, unit and integration tests, audit chain, production build, e2e).

## Built since CP-L1
| Task | Commit | What |
|---|---|---|
| exposure checks | 7315963 | `sales_order_ops` is a security barrier; the plan-balance error no longer quotes totals; the functions and views the app role can reach are pinned by a test; break-glass alert text fixed and readable by owner, partner and support |
| L8 | 8c097a2 | caisse and bank accounts with opening balances |
| L9 | 0032387 | instrument state machine (pure) |
| L10 | e0e257e | instruments, append-only events, `cleared` writes exactly one signed movement; owner-only reversing movement |
| L11 | b2cc541 | allocations (an instrument covers plan items); office covers an order by code through `allocate_to_order` |
| L16 | f6a430e | cash position: encaissé vs total including uncleared, per account and in total |
| L12 | cf8b230 | deposit batch, early presentation flagged (AC-LED-14) |
| L13 | e53d780 | bounce (30-day window set by the database), regularize, dispute, bank fee |
| L14 | a7ca243 | payment entry (blind) and the instruments list |
| L33 | 2a8b8f0 | opening state: opening date once, client and supplier opening balances |
| L34 | 02de9f9 | pilot scenario seed v1 (`pnpm db:scenario`) |
| L15 | 9d38741 | lifecycle on screen (batch, clear, bounce, regularize, dispute, cancel) |
| L27 + L28 | 48712be | statements (domain, service, screens), CSV export, "Comptes" list |

## Acceptance criteria now green
AC-LED-03 (instruments, events, movements, allocations, opening tables: no UPDATE, DELETE or TRUNCATE for anyone), 04, 05, 06, 07, 14, 19, 20, 21 (statements part), 25 (opening state). AC-SEC-04/05 for every new table in the RLS matrix and in `tests/money-visibility.int.test.ts` (zero rows for office, partner, plant, system, anonymous).

## Deviations from the plan
- **L27 and L28 share one commit** (the statement read model and its screens passed the pipeline together).
- **Instrument status is derived, not cached**: the current state is the last event's state, so no UPDATE exists anywhere and nothing can drift (stronger than the plan's definer-trigger cache).
- **Cancel of an instrument** is a `cancelled` event with a reason (the event is the append-only reversal); only a cleared one needs the reversing movement.
- **Office can receive, issue and clear cash the same day**; every other lifecycle step is the owner's (DECISIONS 81: office is blind and posts nothing it cannot read). Office covers an order by typing its code; the database allocates oldest item first and returns a count only.
- **Office learns one thing about a code it types**: whether it matches an open order of that client (the entry is refused otherwise). It is the price of a typo check on a blind screen.
- **Statements before invoices**: "invoiced" and "delivered" show 0 until L17 and the operations module; the commercial side is the orders for now.
- The pilot scenario has **no purchases or invoices yet** (their tasks are not built): supplier payments are outgoing instruments only.
- `SCENARIO_TEST_DATABASE` was added to the list of databases scripts may drop (the scenario test needs a database of its own because the opening date is a singleton).

## Security-relevant changes beyond the plan (flag for review)
- `db/seed/seed-role.sql`: the seed role may SELECT/INSERT the ledger tables it fills (request context `system` only, rows stamped with the system actor) and insert **expense** movements (bank fees). `belgobeton_system` still cannot write the ledger. Registered with `seed: 'insert'` in `TABLE_ACCESS` and checked by the meta-test.
- Three `SECURITY DEFINER` functions are callable by office: `allocate_to_order` (returns a count), `default_cash_account` (returns the id of the caisse), and the earlier `resolve_selling_price` (returns a price: the one deliberate door of decision A, server-side price). All role-checked, fixed `search_path`, listed in `tests/ledger-exposure.int.test.ts`; a new function fails that test until reviewed.

## Open points
1. Decision 81 is still provisional until the owner confirms it (date given: 2026-10-24).
2. `resolve_selling_price` lets the office role read a unit price in the database session that serves its own entry. Closing it means computing totals in SQL; not done.
3. `pg_stat_user_tables` shows every role the number of rows of a table (a document count, never an amount).
4. Partner reads nothing monetary, so the partner has no statements, cash position or instruments; confirm with the owner.
5. The "Comptes" list counts a payment received or deposited as paid for the balance (promise); only cleared counts as paid in the summary.
