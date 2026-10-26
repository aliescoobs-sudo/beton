# CP-INTEGRATION-2: closing the gaps found by CP-INTEGRATION

Plan written 2026-10-26, before any code. Spec: [SPEC-integration.md](../../SPEC-integration.md) (AC-INT-01 to 24). Source of the gaps: [CP-INTEGRATION.md](CP-INTEGRATION.md). Security rules of CLAUDE.md override everything here.

## Method
One task per commit. Each commit: lint (eslint + prettier), typecheck, unit and integration tests, the production build, and the e2e specs of its own screens. Migrations are structure only (D79); demo data comes from `db:scenario`. Unit tests first for the pure part, integration tests for RLS, role matrix, `expectNoFields`, and concurrency where a rule is a race. fr and ar messages with key parity.

## Tasks and checklist
Status: `[ ]` to do, `[x]` done (commit), `[~]` partial.

### Wave I1: sales chain
- [x] I1.1 Delivered BL from the `unloading_finished` tracking step, hand mark outside a rotation, view `delivered_load`, order delivered quantity (AC-INT-01; migration 0064; D97, D98)
- [x] I1.2a File vault library: validation by type and magic bytes, metadata stripping, AES-GCM sealed disk store bound to the file id, key rotation (AC-INT-03; D99; the route and the audit of views are in I1.2b, AC-INT-04)
- [x] I1.2b Signed BL with optional scan: `delivery_file`, one authorized route, audited views (AC-INT-02, 04; migration 0065; D100)
- [x] I1.3 Delivered-not-invoiced queue per client (AC-INT-05; migration 0066; D101)
- [x] I1.4 Invoice from selected BLs, grouped by product, advances, one invoice per BL, office door (AC-INT-06, 07, 08; migration 0067; D102)
- [x] I1.5 Allocation across all open invoices, owner override, bounce (AC-INT-09, 10, 11; migration 0068; D103)
- [x] I1.6 Avoir for rejected or returned concrete (AC-INT-12; migration 0069; D104)

### Wave I2: purchase chain
- [x] I2.1 Supplier invoice as its own document, linked to its order and receipts (AC-INT-13; migration 0070; D105; db:scenario conversion in the Finish step)
- [x] I2.2 Three-way match, acceptance of gaps, payable from the approved invoice (AC-INT-14; migration 0071; D106)
- [x] I2.3 Supplier invoice photo as an attachment, AI extraction interface off (AC-INT-15; migration 0072; D107; there was no feature flag, `AI_EXTRACTION_ENABLED` is it)

### Wave I3: cross-cutting
- [x] I3.1 Order-chain view (AC-INT-16; migration 0073; D108)
- [x] I3.2 Related-documents panel on every document page (AC-INT-17; D109)
- [x] I3.3 Search by document number (AC-INT-18; D110; no migration: every source is read under row-level security)
- [x] I3.4 Server-side PDF (AC-INT-19)

### Wave I4: decisions 91 to 96
- [x] I4.1 Default driver per truck, audited override (AC-INT-20)
- [x] I4.2 Office read-only dispatch view (AC-INT-21)
- [x] I4.3 Overdue orders flagged (AC-INT-22)

### Wave I5: documents only, no code
- [x] docs/SPEC-assistant.md
- [x] docs/REFERENCE-MAP.md

### Finish
- [x] db:scenario walk and DEMO.md (AC-INT-23)
- [x] Full regression: unit, integration, e2e on an idle machine (single worker if load makes it flaky, no raised timeouts)
- [x] Re-run of the CP-INTEGRATION table with the new verdicts (below)
- [x] Unfinished list and new provisional decisions (below)

## Order and dependencies
```
I1.1 ─ I1.3 ─ I1.4 ─ I1.5 ─ I1.6
I1.2a ─ I1.2b          \__ (I1.6 needs the loss record of CP-OPS-4 O14)
I1.2a ─ I2.3
I2.1 ─ I2.2 ─ I2.3
I1.x, I2.x ─ I3.1 ─ I3.2 ─ I3.3 ─ I3.4
I4.x independent (done after the chain waves, before the scenario)
```
Built in the order of the brief, except that I1.2a (the vault) is split out because I1.2b and I2.3 both use it.

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| A file route leaks a document across roles | High | permission and RLS check in the route and the service; 404 for others; exposure test per role |
| Uploaded content runs or is mistaken for another type | High | magic bytes plus declared type, allow-list, re-encode images, served with `Content-Disposition` and `nosniff`, never inline HTML |
| Grouped invoice lines lose the audit trail to the BL | Med | join table line to delivery, unique per delivery; the BL numbers are printed on the line |
| Allocation across invoices breaks the per-order payment state (D85) | High | the invoice state stays derived; parity tests between the old derivation and the new allocation rows |
| Supplier invoice restructuring breaks purchases already entered | High | structure-only migration, rows converted as the system actor (D79 exception) or by `db:scenario` for fake data, parity test on totals |
| Search becomes an enumeration oracle | High | minimum length, RLS, rate limit, lockout, audited misses |
| PDF generation pulls in a dependency or stores files | Med | pinned library decision recorded; PDF built in memory and streamed; never written to disk |
| Scope: 20 tasks | Med | one task per commit; the table below is updated at every commit |

## Verdicts after the work
Re-run of the CP-INTEGRATION table. Verdicts come from the tests and e2e specs of each task and from the full regression below, not from reading alone.

| # | Link | Before | After | What closed it (commit task, acceptance criterion) |
|---|---|---|---|---|
| **Sales chain** | | | | |
| S1 | Order | works | works | untouched |
| S2 | Planned rotations | works | works | office's read-only view, default driver per truck with audited override, overdue flagged (I4.1 to I4.3, AC-INT-20 to 22) |
| S3 | Loaded, BL, no price | works | works | untouched; BL PDF without a price (I3.4) |
| S4 | Delivered | partial | **works** | the unloading step delivers the BL, or the plant marks it for a load outside a rotation; only delivered loads are invoiced (I1.1, AC-INT-01) |
| S5 | Signed BL returned | partial | **works** | recorded once, optional scan attached then or later, type and magic bytes, metadata stripped, encrypted at rest, audited route (I1.2, AC-INT-02, 03) |
| S6 | "Delivered, not invoiced" queue | missing | **works** | per client; owner amounts, office BL numbers/dates/m³/product only (I1.3, AC-INT-04, 05) |
| S7 | Invoice from selected BLs | partial | **works** | one action across a client's orders, grouped by product with BL numbers, "Acompte reçu" / "Net à payer", a BL on one invoice by database constraint (I1.4, AC-INT-06 to 08) |
| S8 | Payment, oldest first | partial | **works** | allocation across the client's open invoices, owner override audited, a bounce reverses and reopens, the 30-day window kept (I1.5, AC-INT-09 to 11) |
| S9 | Instrument lifecycle, bounce | works | works | extended by S8 |
| S10 | Client statement | works | works | feeds the avoirs; PDF added (I1.6, I3.4) |
| S11 | Cash and bank | works | works | untouched |
| **Purchase chain** | | | | |
| P1 | Purchase order | partial | **works** | the supplier invoice is its own document linked to the order and the receipts; purchases entered before keep their former payable (I2.1, AC-INT-13) |
| P2, P3 | Receipt, stock | works | works | untouched |
| P4 | Supplier invoice, three-way match, photo, AI flag | missing | **works, AI reading is an interface only** | match with tolerances as parameters, gaps accepted with a reason after a fresh second factor, photo attached (I2.2, I2.3, AC-INT-14, 15); the AI extraction is a flag that is off and a stub that makes no request: nothing reads an invoice by AI |
| P5 | Payable | works | works | now created from the approved supplier invoice, not from the order (D106) |
| P6, P7 | Supplier payment, statement | works | works | payment allocated to the supplier invoice; PDF added |
| **Cross-cutting** | | | | |
| X1 | Order-chain view | partial | **works** | six stages per order, paid masked for roles without money (I3.1, AC-INT-16) |
| X2 | Links between documents | partial | **works** | panel on every document page from database relations under the caller's RLS (I3.2, AC-INT-17) |
| X3 | Search by document number | missing | **works** | one box and a page; exact or prefix of four characters, numbers only, audited misses, lock-out (I3.3, AC-INT-18) |
| X4 | PDF | partial | **works, French only** | BL, invoice, avoir, quote, both statements; in memory, never stored, watermark in the pilot, audited (I3.4, AC-INT-19). Purchase orders, receipts and payment receipts still have no PDF (not asked) |
| X5 | CSV | works | works | untouched |
| Asked | `docs/REFERENCE-MAP.md`, `docs/SPEC-assistant.md` | missing | **written** | I5 (documents only). The assistant itself is **not built**, by instruction |

Regression (the machine idle, one worker, no timeout raised): see "Regression" below.

## Regression
- Lint, typecheck, unit and integration tests: 199 files, 3 184 tests passed, run after the last code change (the run is repeated in the last commit's message if anything moved).
- Build (`SIMULATION_ENABLED=false NEXT_DIST_DIR=.next-e2e`) and the whole Playwright suite: 133 specs, one worker, 29.8 minutes: 130 passed, 2 design-screenshot specs skipped by design. One failure, a stale assertion (`master-client` expected the plant to have no sales tab, but since I3.1 it holds the order chain); the assertion was corrected and that spec re-run (4 of 4 passed, including the Arabic spec that the failure had skipped).
- The dev database was migrated (75 migrations), `db:scenario` run (it adds the integration walk once), the audit chain verified (9 492 events).

## Not finished
- **Arabic on PDFs.** The standard PDF fonts have no Arabic letters, which print as "?". All PDFs are French (the legal language of invoices). An embedded font is needed for Arabic documents (D111).
- **AI reading of the supplier invoice** is not implemented: only the interface behind `AI_EXTRACTION_ENABLED` (off, refused with real data or in production) and a test that the off path makes no request (D107).
- **The assistant** is specified (`docs/SPEC-assistant.md`) and not built. Nothing of it exists in code.
- **No PDF** for purchase orders, receipts, payment receipts.
- **The older purchases of `db:scenario` keep the former payable** (from the order). Only the new walk uses the supplier invoice as the source. Converting the 80 older ones would need a data migration as the system actor (D79 exception) and was not asked.
- **Scans and photos in the walk.** The demo walk does not attach a scan or a photo (the vault needs the key ring of a running server); the attach flows are covered by the integration and e2e tests.
- **Free-text reasons.** The override reason of a driver, the reason to accept a gap and the avoir reason are free text; short lists are a possible later step.
- **Not checked in a browser by a person.** Everything above passed automated checks; nobody has clicked through it.

## New provisional decisions
All "Ali, provisional until the owner confirms". In docs/DECISIONS.md, section "Integration wave":
97 delivered; 98 delivered quantity; 99 stored documents (the vault); 100 signed BL and its scan; 101 invoicing queue; 102 invoice from the BLs; 103 payment spread over invoices; 104 avoir; 105 supplier invoice; 106 three-way match and payable; 107 supplier invoice photo and the AI flag; 108 order chain; 109 related documents; 110 search by number; **111 server-side PDF (own writer, no dependency, French only, pilot watermark)**; **112 default driver per truck with audited override (reasons in free text, replaces code-order pairing)**; **113 office's read-only dispatch (one database function, client names shown, no order number)**.

Questions for the owner that these raise: may office see client names on the dispatch (113); who may download which PDF (111, with 82); is a step-up needed every time office confirms a money draft once the assistant exists (SPEC-assistant §11); does office get the assistant at all.
