# IMPORT-EXCEL.md — loading the company's Excel data at go-live (T2)

One command reads a workbook, checks every row, and either reports (`--dry-run`) or writes it in **one audited transaction** (`--apply`). It was built and tested with **synthetic files only**; nothing from the company's real files is in the repository, the tests, the logs or any prompt. The real headers are not known yet, so the sheet names and column names are **configuration** (a mapping file per sheet, §4), not code.

## 1. Rules it enforces
| Rule | How |
|---|---|
| Only on the production-mode database | Refused when `TRAINING_MODE=true` (before the file is read or the database opened), when `SIMULATION_ENABLED=true`, unless `REAL_DATA=true`, and when the database carries the training marker (`training_seeded()`). A dry run is refused too: it uses the database. |
| Only owner or app_admin | `--account <email>` must be an active owner or app_admin with a verified authenticator. Every row then goes through the same services as the screens (same rules, row-level security, audit), as that account. |
| Confirmation and second factor | `--apply` and `--rollback` need a typed phrase **tied to the file** (`IMPORT <first 12 hex of the file's sha256>`; `ROLLBACK <last 12 of the run id>`) and a fresh 6-digit code of that account's authenticator (three tries; every wrong code and the success are audited as `permission_denied` / `step_up`, table `import`). |
| Money by deterministic code | Amounts are parsed to **integer centimes** (`parseImportAmount` → `parseCentimes`); no float, no model. |
| No guessing | Refused with a reason: empty or negative amounts, scientific notation, `1,234` / `1.234` (thousands or decimals?), `1.234,50`, three or more decimals (a spreadsheet float such as `1234.4999999999998`); impossible dates (`31/02/2026`), two-digit years, mixed separators, a text date in the other order than the mapping declares, serials outside 2000–2099. |
| All or nothing | The whole file is one transaction. It commits only if **no sheet** has a problem; a single bad row anywhere means nothing is written. |
| Dry run writes nothing | It does the real work, in the same order, **inside a transaction that is always rolled back**, so a sheet that refers to a type or client created by an earlier sheet of the same file is checked for real. Not a row, not an audit entry stays. |
| Idempotent | The same bytes are never imported twice (the file's sha256 is in the audit trail). A changed file skips every row that already exists (by code, name, ICE, plate, number…) and adds the new ones. |
| No hard delete | A rollback archives and cancels; it never deletes (§6). |
| What is stored where (R14-09) | **Two different things, do not mix them up.** (1) The **summary** `import` audit row (one per run) holds only the run id, the sha256, the size and per sheet the counts. (2) The **row** audit rows, which every service writes when it creates a client, price, cheque… **do contain the values** (names, ICE, amounts, as for any entry made on a screen), under their existing row-level security and the money-visibility rules (money tables: owner and support only; the restricted performance tables as documented). "The audit never holds file values" is therefore NOT true of the operation as a whole. The text **report** (screen and `.logs/`) holds only: the file hash, sheets by **position** ("Sheet 2", never the name the file gave them), the kind, row numbers and fixed phrases. The in-memory `WorkbookReport` object also carries each row's label, which is the file's own text: treat it as sensitive, never print or store it. |

## 2. The workbook
One `.xlsx` with **one sheet per kind**. Sheets are applied in this order whatever their order in the file, because later ones refer to earlier ones (a recipe to its type and components, a price to its type, a balance or cheque to its client):

`Types` → `Composants` → `Recettes` → `Clients` → `Fournisseurs` → `Camions` → `Pompes` → `Prix` → `Soldes` → `Cheques` → `Facture`

Those are the built-in sheet names (kind in parentheses): Types (`concrete_types`), Composants (`components`), Recettes (`recipes`), Clients (`clients`), Fournisseurs (`suppliers`), Camions (`trucks`), Pompes (`pumps`), Prix (`selling_prices`), Soldes (`opening_balances`), Cheques (`cheques_in_transit`), Facture (`invoice_sequence`). A sheet nobody maps is left alone and listed in the report. A CSV counts as one sheet called `csv` (map it with `"sheet": "*"`).

Fields per kind (`*` = required; the others may be absent). The names in brackets are the headers accepted **by default**, case and accents ignored; a mapping file replaces them.
- **concrete_types**: `code*` [code, type, classe], `label*` [label, libellé, désignation, nom]
- **components**: `nameFr*` [nom, désignation, composant…], `nameAr` [nom ar…], `unit*` (g, mL or L) [unité…], `purchaseUnit` [unité d'achat, conditionnement], `factor` [contenu, facteur] (both or none: *Sac 50 kg* = 50000 g)
- **recipes**: `type*`, `component*` (code or French name), `qty*` per m³, `unit` (kg, g, t, L, mL), `from*` (date), `plant` (empty = all plants). One row per line; same type + plant + date = one version; the date must follow the latest version of that scope
- **clients**: `name*`, `kind*` (société/company, particulier/person), `ice` (15 digits, required for a company), `phone`, `contact`, `terms` (days), `notes`
- **suppliers**: `name*`, `category*` (cement, aggregates, … see the screen), `ice`, `phone`, `terms`, `lead`
- **trucks**: `code*` (T1, T2…), `plate*`, `capacity` (m³, 1 to 30), `kind` (default mixer), `plant` (plant code)
- **pumps**: `code*` (P1, P2…), `plate*`, `capacity`, `plant` — the kind is always pump
- **selling_prices** (the **reference price per plant**): `type*`, `price*` (MAD HT per m³), `from*`, `plant` (a plant code = that plant's price; empty = the price for all plants)
- **opening_balances**: `party*` (client/fournisseur), `code*` (the party's code **or its exact name**), `amount*` (positive; what the party owes us / we owe them), `reference`. The opening date of the books is entered once (`--opening-date YYYY-MM-DD` if none is set yet)
- **cheques_in_transit**: `client*` (code or exact name), `method*` (chèque / LCN), `number*`, `bank`, `amount*`, `written*` (date on the cheque). Each becomes an instrument *received*, not deposited, not allocated; the duplicate key is client + number + bank
- **invoice_sequence** (the **last 2026 invoice number**): `year*`, `last*`. The next invoice is `last + 1`; the number only moves forward (a lower or used number is refused; the same number is "already there")

## 3. Commands
```
corepack pnpm import:excel --init-mapping imports/mapping              # editable copy of the defaults (never overwrites)
corepack pnpm import:excel --dry-run imports/book.xlsx [--mapping imports/mapping] [--opening-date 2026-01-01]
corepack pnpm import:excel --apply   imports/book.xlsx --account owner@example.test [--mapping …] [--opening-date …]
corepack pnpm import:excel --rollback <run id> --account owner@example.test
```
On the server, run it through the ops container (`./scripts/ops/ops.sh import-excel …`; for the two prompts of `--apply` and `--rollback` use `./scripts/ops/dc.sh run --rm ops node --import ./scripts/register-ts-paths.mjs scripts/import-excel.ts …` so the terminal is attached, otherwise pipe the two lines in). Files live in `./imports/` (git-ignored, never in the image). The report is printed and saved in `./.logs/import-<mode>-<time>.txt` (the file is created `0600`, exclusively, in a `0700` folder that is not a link): file hash, per sheet (by position) the counts, then `row <n>: <problem>`; **no cell values, no sheet names**. An unexpected error prints only a fixed code (`DATABASE_ERROR <SQLSTATE>`, `SYSTEM_ERROR <code>` or `UNEXPECTED_ERROR`), never the database's message, which can quote a row. Exit codes: 0 done, 1 refused or problems or a failed commit, 2 usage, 4 **commit outcome unknown** (check before running again), 5 unexpected error.

`--apply` always runs the dry run first and shows it. Typical session: dry run → read → fix the file → dry run → `--apply` → keep the run id printed in the report.

## 4. Adapting to the real headers (mapping files)
Write one JSON file per sheet (or `--init-mapping` and edit). `--mapping <file-or-folder>` replaces the built-in defaults for the sheets it names; with it, every mapped sheet **must** exist in the workbook (a typo in a sheet name is an error, not a silent skip).
```json
{
  "version": 1,
  "sheet": "Liste clients 2026",
  "kind": "clients",
  "headerRow": 3,
  "dateFormat": "dmy",
  "columns": {
    "name": ["Raison sociale", "Désignation"],
    "kind": "Nature",
    "ice": "N° ICE",
    "terms": "Délai (jours)"
  },
  "defaultPlant": "TETOUAN"
}
```
- `sheet`: the tab's name (case and accents ignored), or `"*"` for a CSV / a one-sheet file.
- `kind`: one of the eleven kinds above.
- `headerRow`: 1-based row of the headers (default 1); rows above (a title, a date) are ignored. Row numbers in reports are the sheet's own.
- `dateFormat`: `dmy` (day first, default), `mdy`, or `iso`. **Declared, never guessed**: `03/04/2026` is 3 April under `dmy`, 4 March under `mdy`, an error under `iso`. Excel date cells and `2026-04-03` always work.
- `columns`: field → the header name(s) of **this** sheet. It replaces the default names of that field; fields not listed keep their defaults. An unknown field name is refused (a typo is not ignored).
- `defaultPlant`: the plant code used by a row that has no plant (prices, recipes, trucks). Plants must exist (created in the app) before the import.
Two mapping files may not name the same sheet. Unknown keys are refused.

## 5. Rehearsing with synthetic files
`corepack pnpm import:fixtures <folder> [--prefix FK] [--plants CODE1,CODE2]` writes `fake-golive-valid.xlsx` (every sheet, no problem) and `fake-golive-problems.xlsx` (ten known faults, listed in `EXPECTED_PROBLEMS`). Everything in them is invented (names say FICTIF, ICE start with 999, phones 0600000…, "Banque Fictive"). The two plants must exist in the database you rehearse on. Rehearse on a restored copy or a staging stack in production mode, never on the training instance (it refuses).

## 6. The way back
- **Before the commit**: any problem, any exception, a Ctrl-C: the transaction rolls back, nothing is written.
- **After the commit**: `--rollback <run id>` (typed phrase + authenticator code). In one transaction it **archives** the clients, suppliers, trucks and pumps, concrete types and components the run created, and **cancels** the cheques/LCN it recorded (only while they are still *received*; a cheque that has moved on blocks the whole rollback, nothing changes). It writes a `reverse` audit entry on the run. A second call does nothing.
- **Stays by design** (listed in the report, never touched): price versions, recipe versions, the opening of the books and the invoice sequence are sealed or forward-only; correct them with a newer version or a reversing entry from the screens.
- After a rollback the same bytes can be imported again, but the archived rows still count as "already there": reactivate them from the screen, or use a changed file.
- The cleanest way back **before go-live** is still the backup taken just before the import (RUNBOOK §5): take one, then import.
