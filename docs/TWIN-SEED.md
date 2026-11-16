# TWIN-SEED.md — the fictitious realistic twin (T20, D251)

A deterministic seed of **fictitious** data with the structure and the distributions of the real files, so that the owner can walk through the whole application on staging. It is a **script, never a migration** (decision 79), fixed PRNG seed (`20261115`), fixed anchor date **15 Nov 2026** (every date is relative to it). Real data never goes near it (CLAUDE.md rules, D249: no CIN, no birth date, no home address; business identifiers only).

## 1. What it needs, what it refuses

| Condition | How it is checked |
|---|---|
| The person running it says the database is fictitious | environment flag `TWIN_SEED_FICTITIOUS=true` (exactly that word) |
| The database is marked fictitious | the training marker row (`public.training_marker`, written by the training seed when it completes) |
| Not a production-looking environment | refused when `APP_ENV=production`, `REAL_DATA=true`, `TRAINING_MODE` is not `true`, or the database name, the database host or the application host carries `prod`, `production`, `live`, `real` as a word (`scripts/seed/twin/guard.ts`, unit-tested) |
| Nothing else lives in the database | refused when orders, loads or payments exist without the twin marker (a half-finished run or somebody's data) |
| Second run | does nothing: `public.twin_seed_marker` (migration 0254, structure only) holds one row once the seed has finished, and the seed is a no-op when it exists |

The role users are **not** invented here. The training seed (`scripts/seed-training.ts`) creates the seven fictitious accounts (owner, app_admin, sales office, purchasing office, one plant manager per plant, accountant) with its own password handling; the twin finds them by their reserved address. For this, the training seed has a second profile: `TRAINING_SEED_PROFILE=twin-base` seeds only the master data, both plants, the accounts, the finance switch and the marker (none of the pilot's activity), and the twin builds everything else on it.

## 2. Running it

### On your Mac (scratch database)
```
corepack pnpm db:up
E2E_TEST_RUNNER=playwright node --import ./scripts/register-ts-paths.mjs scripts/seed/twin/dev-base.ts --twin
```
`dev-base.ts` rebuilds the scratch database (`belgobeton_training_test`: migrations, training seed in profile `twin-base`) and, with `--twin`, runs the twin on it (about 50 seconds). The same thing is done by the integration test and by the twin e2e.

### On staging (the VPS)
Staging is reset, never restored (docs/STAGING-VPS.md §0). The twin is made on a **fresh** instance, in this order:

1. On the VPS, in `.env.staging.ops` (the operator's file, never committed) add the two lines:
   ```
   TRAINING_SEED_PROFILE=twin-base
   TWIN_SEED_FICTITIOUS=true
   ```
2. `./scripts/staging/reset.sh` (if the instance already exists), then `./scripts/staging/up.sh`. `up.sh` runs the training seed, which now stops at the structure and the accounts.
3. `./scripts/staging/ops.sh seed-twin` (prints "Twin seeded."; about a minute).
4. Read the owner's credentials one account at a time as in STAGING-VPS §12 (`show-accounts.sh proprietaire`). Nothing about accounts changes.

Remove the two lines from `.env.staging.ops` afterwards if the instance is going to be kept without the twin. Nothing is pushed or deployed by this document: it describes what the operator runs.

### Reset
Drop the database and make it again (the same as for the training instance): on staging `./scripts/staging/reset.sh` then steps 2 and 3; on the Mac the scratch database is rebuilt by `dev-base.ts`. There is no "undo" of a twin inside a database: the seed refuses a database that holds activity without its marker, so a failed run (the seed is not one transaction: it goes through the application's own services) is cleaned by a reset, not by a re-run.

## 3. What is in it (after a run)

| Item | Content |
|---|---|
| 1. Structure | 2 plants (Tétouan, Chefchaouen); classes B15, B20, B25, B30, B35 with the A1 recipes and doses (assumption set A1, D237): the master data's mixes plus B15 and B35 and one own mix per plant (B30 Tétouan, B25 Chefchaouen), list prices per class and plant; the A1 cost rates, price grid and fuel norms of the master data; 9 mixers (4 × 16 m³ Tétouan, 5 smaller Chefchaouen) and 3 pump trucks; 30 clients (24 companies, 6 private individuals) with commercial names in different cases (`TAZI TRAVAUX ET CONSTRUCTION`, `sarl andalous bâtiment`, `Bennani TP`), 7 requiring a client PO number, 12 on TTC and 18 on HT, aliases, a behaviour each (good, slow, late, bad payer); 12 suppliers (2 cement, 3 aggregates, 2 admixtures, 1 water, 1 transport, 2 fuel, 1 spare parts). Phones (`0000 00 xxxx`) and ICE (`0000000000xxxxx`) are in a reserved fake range; company names say "(fictif)"; people are codes (`Client particulier P-017`, `COM-01`). |
| 2. Sales 1 Sep to 15 Nov | about 460 orders (about two thirds Tétouan) through the order service, working days only, each plant by its own rhythm; chute and pump orders (about 100 pump jobs), mixed payment presets by client terms (cash, advance 50 %, three instalments, 30-day cheque, LCN at 45 or 60 days); 9 cancellations before production as reversing rows with a reason; about 1 515 BLs through the same code as the plant's own action (stock movements and the cost snapshot of every BL come from it; A1 transport rates make the snapshots complete), 93 % of signed BLs back, the later loads of the last working day still on the road; about 410 invoices, 2 credit notes, and an uninvoiced queue; 3 orders for the next two working days. |
| 3. Money | about 300 client payments (297) by cash, cheque, LCN, transfer, advance and instalment (receive, allocate to the exact plan item, deposit, clear), their delay depending on the client's behaviour, so the balances spread over current, 1-30, 31-60 (live data) and 61-90, 90+ and "no due date" (opening items, see 5); cheques and LCN handed over and due in the next 1 to 10 days; one bounced cheque (fee booked); one 45 000 MAD credit nobody has allocated; 62 supplier cheques, LCN and transfers with written and due dates (some paid late, some not yet cleared); an outgoing payment of 72 000 MAD above the upper limit in the owner's approvals inbox and one of 2 800 MAD in the middle band waiting for the Responsable; 14 charges with and without a supporting document (the small paid ones without one are flagged by the application); one cash and two bank accounts with openings that keep every account above zero on every day. |
| 4. Stock | opening stock (31 Aug) per plant and component, sized so that stock never goes below zero on any day; about 105 stock purchases (cement, sand, two gravels, water, admixture) through the purchase service, arrivals confirmed by the plant manager, receipts recorded, three arrivals counted short, some purchases still on their way; thresholds; services bought (transport, spare parts); fuel tanks, about 190 fills in all (every mixer, every month) against the per-trip norm, fuel purchases, and **one** truck-month (T2, October) that burns about a third more than the norm, which the fuel check flags; a count round by each plant manager (9 small variances and one exact count posted inside the tolerance, 2 outside it waiting for a decision). |
| 5. Opening for 30 Nov | ledger opening date 30 Nov 2026, then through the real importer kinds (`runImport`, dry run first): `open_items` (per-invoice items of 8 clients and 3 suppliers, older invoices), `opening_balances` (one client and one supplier known only by their single line: "aging unknown"), `obligations` (a loan and a leasing, 30 instalments from December), `opening_stock` (three small components counted on 30 Nov in both plants). |

## 4. What is injected on purpose

| Defect | Where | Count |
|---|---|---|
| Missing BL numbers | the live BL series is one gapless run per year; numbers are **taken and never used** | 12 per plant for September and October, 6 for the part of November: 60 in all |
| Duplicate BL numbers | the plants' **paper books** (the history layer: `history.batch` / `history.delivery`, one applied batch per plant, one row per BL, each plant on its own running number: Tétouan from 4100, Chefchaouen from 2300). The live `delivery.bl_no` is unique by constraint, so duplicates cannot exist there. | 4 (2 per plant) |
| Missing numbers in the paper books | the same rows | about 12 per plant-month (the number jumps by two) |
| A date stored as text | one paper-book row, flagged in its `legacy` cell and its note | 1 |
| Empty pump column | paper-book rows, `pump_mode = unknown` | about one in twenty |
| A payment above the upper limit, a bounced cheque, an unallocated credit, a flagged fuel truck-month, two counts outside the tolerance, a client PO required on 7 clients, payments without a document | see section 3 | |

## 5. Tests

- **Determinism** was checked by hand on 16 Nov 2026: two fresh builds gave the same order codes and totals, the same BL series (hash of number, date and volume), the same payments total and the same paper books (hash of every paper number). A change of the PRNG seed, of the anchor or of the plans changes them on purpose.
- `scripts/seed/twin/*.test.ts` (unit): the guard (flag, production words, the fake ranges), the sales plan (deterministic, covers the period, never double-books a pump, PO numbers), the paper-book numbering (exactly 4 duplicates, jumps, one text date), the stock plan (never below zero), the payment stories (never after the anchor, cheques due in the next days stay in hand), no real-looking identifier in the sources, the data-scope scan covers `scripts/seed/twin`.
- `tests/twin-seed.int.test.ts` (integration, scratch database): the seed runs on a clean database, a second run changes **no row count**, it refuses without the flag, on a production-looking environment and without the marker, and the invariants hold (ledger totals equal the sum of their parts, allocations never exceed an instrument or a plan item, stock and cash never below zero, BL numbers follow the series except the burned ones, only fictitious identifiers, the audit chain is intact over everything written).
- `e2e-twin/twin.spec.ts` (own config `playwright.twin.config.ts`, own database and server on port 3103): with the seeded data the owner opens the dashboard, the aging of clients and suppliers, the cash forecast, the approvals inbox, the margins and the order flow and checks that none is empty. Run it on the same build as the main e2e: `NEXT_DIST_DIR=.next-e2e corepack pnpm test:e2e:twin`.

## 6. Limits to know about

- **The clock.** The screens compute "today" from the application's clock. The twin is built around 15 Nov 2026; on another day the aging buckets and the "due in the next days" cheques move with the day (the data are the same). For figures exactly as designed, look at it on 15 Nov 2026 (or with the simulation clock where it is on).
- **Counts are dated the day the seed runs.** The count door (`propose_stock_count`) always counts "today"; the count round is therefore dated the day of the seed, not 15 Nov.
- **Paper books versus live BLs.** The two numberings are separate on purpose (see 4). The history importer itself is not run: it is off on staging (D226); its rows are written as an applied batch (SECURITY-DEBT).
- **No phone accounts, no rotations.** The base profile makes no driver account and no rotation tracking; pump jobs are scheduled with two pump operators (records, no phone account).
- **The loan and the leasing** are loaded once, through the opening importer (item 5); there is no second, "live" loan.
- **The importer runs per kind** (`runImport`) with the dry run first. The full workbook path (typed phrase, fresh second factor) is a human step the seed does not play.
