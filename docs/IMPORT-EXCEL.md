# IMPORT-EXCEL.md — loading the company's Excel data at go-live (T2)

One command reads a workbook, checks every row, and either reports (`--dry-run`) or writes it in **one audited transaction** (`--apply`). It was built and tested with **synthetic files only**; nothing from the company's real files is in the repository, the tests, the logs or any prompt. The real headers are not known yet, so the sheet names and column names are **configuration** (a mapping file per sheet, §4), not code.

## 1. Rules it enforces
| Rule | How |
|---|---|
| Only on the production-mode database | Refused when `TRAINING_MODE=true` (before the file is read or the database opened), when `SIMULATION_ENABLED=true`, unless `REAL_DATA=true`, and when the database carries the training marker (`training_seeded()`). A dry run is refused too: it uses the database. |
| Only owner or app_admin | `--account <email>` must be an active owner or app_admin with a verified authenticator. Every row then goes through the same services as the screens (same rules, row-level security, audit), as that account. |
| Confirmation and second factor (R14-11, T7 C) | `--apply` and `--rollback` need a typed phrase and a fresh 6-digit code of that account's authenticator. **The phrase covers the whole decision**: `IMPORT <sha256 in full>` where the digest is taken over the **full file hash, the mappings in force and the opening date** (another file, mapping or date is another phrase; the command prints what the confirmation covers); `ROLLBACK <the whole run id>`. **The code is checked like the application's own step-up**: its 30-second step is claimed atomically in `totp_used_step` (a code already used anywhere, by a sign-in, another import or a rollback, or an earlier step, is refused: use the next code), the failure budget is **persisted** (`login_attempt`, keyed hashes; the same limit and window as the sign-in, so restarting the command does not reset it, and a locked account answers "locked" even for a good code), and the account is checked again for eligibility (active, owner or app_admin, authenticator verified) at the moment of use. **The verified code is bound to the operation**: the importer recomputes the operation from the file, mappings and opening date it is about to apply and refuses a proof for another one. Three tries per command; every wrong code and the success are audited as `permission_denied` / `step_up`, table `import`. |
| Money by deterministic code | Amounts are parsed to **integer centimes** (`parseImportAmount` → `parseCentimes`); no float, no model. |
| No guessing | (R14-04) A workbook in the **1904 date system** is refused; **two columns** with an accepted header for one field block the sheet; a **CSV with an unclosed quote** is refused; a **formula cell** refuses the sheet unless its mapping says `"allowCachedFormulaValues": true` (then the value Excel last stored is read and the report says "CACHED FORMULA VALUES USED: n"; a stored value can be stale, so prefer pasting values). Refused with a reason: empty or negative amounts, scientific notation, `1,234` / `1.234` (thousands or decimals?), `1.234,50`, three or more decimals (a spreadsheet float such as `1234.4999999999998`); impossible dates (`31/02/2026`), two-digit years, mixed separators, a text date in the other order than the mapping declares, serials outside 2000–2099. |
| All or nothing | The whole file is one transaction. It commits only if **no sheet** has a problem; a single bad row anywhere means nothing is written. |
| Dry run writes nothing | It does the real work, in the same order, **inside a transaction that is always rolled back**, so a sheet that refers to a type or client created by an earlier sheet of the same file is checked for real. Not a row, not an audit entry stays. |
| Serialized and idempotent (R14-08) | **One import (or rollback) at a time** (a database advisory lock held to the end of the transaction). The same bytes are never imported twice (the file's sha256 is in the audit trail). In a changed file a row that finds an existing record (by code, name, ICE, plate, number…) is "already there" **only if what it says is the same** (a blank cell means "not said" and is not compared); a different phone, ICE, price, amount, recipe line, label… is an **error naming the field** and blocks the whole file. Two opening-balance rows for one party in a file are an error. |
| No hard delete | A rollback archives and cancels; it never deletes (§6). |
| What is stored where (R14-09) | **Two different things, do not mix them up.** (1) The **summary** `import` audit row (one per run) holds only the run id, the sha256, the size and per sheet the counts. (2) The **row** audit rows, which every service writes when it creates a client, price, cheque… **do contain the values** (names, ICE, amounts, as for any entry made on a screen), under their existing row-level security and the money-visibility rules (money tables: owner and support only; the restricted performance tables as documented). "The audit never holds file values" is therefore NOT true of the operation as a whole. The text **report** (screen and `.logs/`) holds only: the file hash, sheets by **position** ("Sheet 2", never the name the file gave them), the kind, row numbers and fixed phrases. The in-memory `WorkbookReport` object also carries each row's label, which is the file's own text: treat it as sensitive, never print or store it. |

## 2. The workbook
One `.xlsx` with **one sheet per kind**. Sheets are applied in this order whatever their order in the file, because later ones refer to earlier ones (a recipe to its type and components, a price to its type, a balance or cheque to its client):

`Types` → `Composants` → `Recettes` → `Clients` → `Fournisseurs` → `Camions` → `Pompes` → `Prix` → `Soldes` → `Cheques` → `Facture`

Those are the built-in sheet names (kind in parentheses): Types (`concrete_types`), Composants (`components`), Recettes (`recipes`), Clients (`clients`), Fournisseurs (`suppliers`), Camions (`trucks`), Pompes (`pumps`), Prix (`selling_prices`), Soldes (`opening_balances`), Cheques (`cheques_in_transit`), Facture (`invoice_sequence`), Compteurs (`doc_counters`), Comptes (`account_balances`), ChequesEmis (`cheques_issued`). A sheet nobody maps is left alone and listed in the report. A CSV counts as one sheet called `csv` (map it with `"sheet": "*"`).

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

- **doc_counters** (T19, D246: numbering continues from the paper or Excel series): `prefix*` (CMD, BL, ACH or FA), `year*`, `last*`. The next document of that series and year is `last + 1`; forward only
- **account_balances** (T19, D246: the cash and bank opening): `account*` (the exact label of an existing cash or bank account), `asOf*` (the opening date), `amount*` (MAD, may be negative), `note`
- **cheques_issued** (T19, D246: cheques and LCN we issued and that are not cleared): `supplier*` (code or exact name), `method*` (chèque / LCN), `number*`, `bank`, `amount*`, `written*` (the date on the cheque = its due date). Each becomes an instrument *issued*; the duplicate key is supplier + number + bank

Every row of the opening position (balances, cheques in transit and issued) is stored with `source = 'opening_30_11'`; only the owner and app_admin can set it, and the tables are insert-only, so such a row is corrected by a reversing entry, never edited. The dry run prints a TOTALS CONTROL (rows read, rows to write, MAD of the file and of the rows to write): compare it with the Excel closing figures before `--apply`. A file already applied is recognised by its hash.

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
- `allowCachedFormulaValues` (default false): accept the stored values of formula cells in this sheet; without it a sheet with a formula is refused (see §1).
Two mapping files may not name the same sheet. Unknown keys are refused.

## 5. Rehearsing with synthetic files
`corepack pnpm import:fixtures <folder> [--prefix FK] [--plants CODE1,CODE2]` (the trucks are T1, T2 and P1 by default: a database that already has other trucks with those codes answers a conflict, see R14-08, so rehearse on a clean copy) writes `fake-golive-valid.xlsx` (every sheet, no problem) and `fake-golive-problems.xlsx` (ten known faults, listed in `EXPECTED_PROBLEMS`). Everything in them is invented (names say FICTIF, ICE start with 999, phones 0600000…, "Banque Fictive"). The two plants must exist in the database you rehearse on. Rehearse on a restored copy or a staging stack in production mode, never on the training instance (it refuses).

## 6. The way back
- **The same file again** (T10b): if the same bytes were imported with the same mappings and opening date and that run was not rolled back, the answer is "already imported (run …)": nothing is planned, validated or written, and the present books are **not** compared with the file again; to import again, roll that run back first. The same bytes with another mapping or opening date are refused with a reason. A run recorded before the mappings and opening date were stored is refused too, never assumed to be the same.
- **Before the commit**: any problem, any exception, a Ctrl-C: the transaction rolls back, nothing is written.
- **After the commit**: `--rollback <run id>` (typed phrase + authenticator code). In one transaction it **archives** the clients, suppliers, trucks and pumps, concrete types and components the run created, and **cancels** the cheques/LCN it recorded (only while they are still *received*; a cheque that has moved on blocks the whole rollback, nothing changes). It writes a `reverse` audit entry on the run. A second call does nothing.
- **Stays by design** (listed in the report, never touched; R14-10 corrected the inventory to the real tables): `selling_price` and `recette` versions, **`ledger_opening` (the opening DATE of the books, a singleton)**, **`opening_party_balance` (the opening balances)**, `doc_sequence` (the invoice sequence) and `code_sequence` (the counters of generated codes). A table the tool does not know that a run wrote to is listed too, as "<table> (unclassified)", never left out. The owner's and the app_admin's reports are the same complete inventory (tested: the app_admin reads as the owner, counters included; T10b, R15B-12). An earlier version of this guide said otherwise; that was wrong.
- **Correction procedure for what stays** (decided before real-data use): (1) the opening **date** is entered once and cannot be changed by a file: a wrong date is corrected by the owner through the application's own correction path, never by importing again (a second file with another `--opening-date` does NOT move it; this is tested); (2) a wrong opening **balance** is corrected with a reversing entry / a newer opening line from the screen of the books, by the owner, with its audit; (3) a wrong **price or recipe** is corrected with a NEWER version (the old one stays, as for any price change); (4) the invoice sequence only moves forward: a number issued by mistake is cancelled with an avoir, not reused; (5) if the whole load was wrong and nothing has been used yet, the cleaner way back is the backup taken just before the import. Write down which one was used (with the run id) in the go-live log.
- After a rollback the same bytes can be imported again, but the archived rows still count as "already there": reactivate them from the screen, or use a changed file.
- The cleanest way back **before go-live** is still the backup taken just before the import (RUNBOOK §5): take one, then import.

## 7. The history importer (T11): deliveries and expenses of the monthly files
Decisions 210 to 214. This is a **second importer**, separate from the master-data one above: it loads about nine months of **historical deliveries and expenses** from the company's monthly Excel files as a flagged layer (`source = 'history_import'`, `batch_id`). History **never** decrements live stock, creates an invoice or a ledger movement, or appears on the plant board, the driver screens or dispatch; it feeds reports, client statements (quantities only) and analytics. The company's real files stay in `~/KAYAS-real-data-private` (outside the repository) and are read only on a production-mode local stack (RUNBOOK §4b).

### 7.1 Commands
```
corepack pnpm import:twin /path/to/new-folder [--seed N]                      # the fictitious twin of the files (training rehearsal)
corepack pnpm import:history --init-mapping mapping/                          # example mapping files, never overwritten
corepack pnpm import:history --dry-run <folder> --mapping <file>              # reads and reports; writes nothing
corepack pnpm import:history --stage   <folder> --mapping <file> --account <owner email>
corepack pnpm import:history --apply   <folder> --mapping <file> --account <owner email>
corepack pnpm import:history --rollback <batch id> --account <owner email>
```
One folder = the monthly files of **one plant and one kind**; the mapping file names both. Files are numbered by their sorted position ("File 3"); a file name is never read as data (some files hold rows of the following month: the row date is the truth) and never printed. A missing month (the twin has no February for the Tétouan plant) is simply a file that is not there: nothing is invented.

### 7.2 The flow
1. **Dry run**: reads, reports counts, row numbers and open decisions; writes nothing.
2. **Stage**: writes the batch, the labels to decide and the quarantined rows. The same files and mapping again change nothing.
3. **Decide** on **Import historique : décisions** (owner and app_admin; fr, ar, ary): clients (similarity groups are a suggestion; merge a spelling into an existing client, create a new one, or keep the label only), trucks (record or unknown), drivers (record or historical label; **no account is ever created**), concrete types and pump modes (alias table), expense categories, and the quarantined rows (fix the date or the quantity, or discard). Nothing is merged automatically.
4. **Compare** on the *Rapprochement* tab: per plant and month, rows read, imported, quarantined and SUM(m³) (or MAD) read against imported, to compare with the totals cell of each Excel.
5. **Apply**: blocked while any required mapping or quarantined row is open. It asks for the typed phrase `HISTORY <set hash>` and a fresh authenticator code bound to the operation, then writes in one audited transaction under an advisory lock.
6. **Rollback**: marks the batch rolled back (every report ignores it at once) and archives the clients it created. Rows are never deleted or changed; the staging decisions stay.

### 7.3 The mapping file (one per plant and kind)
```json
{ "version": 1, "kind": "deliveries", "plant": "TET", "plantCode": "TETOUAN", "sheet": "LIVRAISON 1", "headerRow": 2,
  "dateFormat": "dmy", "columns": { "driver": ["TRANSPORTEUR"], "truck": ["CAMION"], "bl": ["B,L"] },
  "legacyColumns": ["COMERCIAL", "CODE CLIENT"], "blankHeaderField": null, "includeSheets": [], "fileMonths": {} }
```
`plant` is how the files call the plant, `plantCode` is the plant's code in the application (configuration, e.g. the files tagged TET are the Tétouan plant). Columns are found **by header name**, never by position (the two plants differ in order and in spelling). `legacyColumns` are kept as they are in the row's `legacy` JSON (never interpreted). `blankHeaderField` gives a header-less column a field when exactly one such column holds data. For expenses: `sheet` is the monthly journal, `includeSheets` lists other sheets that are read only if they have a DATE column, and `fileMonths` gives the month of a journal with no DATE column by file position (`{"1": "2026-01"}`). Every other sheet (copied templates, stale notes) is **ignored and listed by position**.

### 7.4 What it does with the known problems
| Problem | Behaviour |
|---|---|
| Totals row (a formula), blank rows, 257 formatted columns, an autofilter a strict parser rejects | ignored and counted; the reader never looks at the autofilter; the 1904 date system is still refused |
| No date, empty or unreadable m³, no amount | the row is **quarantined** with a fixed reason; never imported silently |
| Concrete type spellings (`B25 `, `B 25`, `BB25`, `B26`…) | one key per spelling; a spelling that equals an existing type code is decided; every other one waits for the owner |
| Pump (`POMPE`, `P`, `GOULOTTE`, `G`, `P SITRAD`, empty) | the first four are built in; `P SITRAD` waits; empty is `unknown` |
| Client names (first names alone, trailing digits, typos) | one key per spelling, similarity groups on the screen, owner merges or creates |
| Trucks (spacing, case, an internal code vs a plate) | one key per spelling; the owner maps each to a truck or to unknown |
| Delivery note (BL) | kept raw; duplicates (row numbers), gaps (a count) and absurd values (suspect) are reported, never rejected or fixed |
| Tax basis HT/TTC | the HT/T cell; if empty and ADJUVANT is exactly HT or TTC, from there; otherwise empty |
| Observations with a third-party tag | stored as a free-text note on the row |
| Expense text with litres (`GASOIL 84,22 L`) | litres stored as integer millilitres in `quantity_ml`; the category comes from an alias table, unknown ones go to staging |

Money is integer centimes (the T2 parser); quantities are integer litres; no float, no model. Reports contain counts, row numbers, hashes and fixed phrases; never a cell, a name, a file name or a sheet title.

### 7.5 The guard (decision 213)
- `TRAINING_MODE=true`: the history importer runs **only** on files that carry the twin marker sheet (`TWIN_MARKER`) and in which every client, driver and site label contains `FICTIF` and every expense label is in the twin vocabulary. A real-looking file is refused there.
- Production mode: it runs on real files only, under the T2 gates (`REAL_DATA=true`, `SIMULATION_ENABLED=false`, no training marker in the database), and it **refuses** a twin-marked file.
