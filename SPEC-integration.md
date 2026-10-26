# Spec: `integration` (closing the gaps between modules)

Status: DRAFT 2026-10-26 · Source: [docs/checkpoints/CP-INTEGRATION.md](docs/checkpoints/CP-INTEGRATION.md) and the owner-side brief of 2026-10-26 · Plan and checklist: [docs/checkpoints/CP-INTEGRATION-2.md](docs/checkpoints/CP-INTEGRATION-2.md) · Depends on: `ledger`, `operations`, `master-data`, `platform-security`, `rules-engine`

## 1. Objective
Documents flow from one module to the next without re-typing: order, rotation, BL, delivery, signed BL, invoice, payment, avoir; purchase order, receipt, supplier invoice, payable, payment. Nothing in this spec weakens RBAC, RLS, column grants, 2FA, audit or encryption (CLAUDE.md, Principle #0). Money is integer centimes computed by deterministic code; corrections are reversing entries; migrations are structure only (Decision 79); demo data comes from `db:scenario`; the pilot uses fake data only.

## 2. Cross-cutting rules
- **Office doors** (D84) stay the pattern for any office write that touches money: office sends codes or ids, the database builds the document, the answer is the document number only.
- **Quantities and money are different shapes.** A response for a role without money access has no money key at all (`expectNoFields`), and every new money table or view is added to the exposure tests.
- **Files** (BL scans, supplier invoice photos): images (JPEG, PNG, WebP) and PDF only, checked by declared content type and by magic bytes, size limit as a parameter; EXIF stripped from images; stored outside any public path, encrypted at rest with the existing keyring; served only through an authorized route that re-checks the caller's permission and RLS; every upload and every view audited.
- **Links between documents** come from database relations and are filtered by the caller's RLS; a document the role cannot open appears as a number without a link, or not at all.
- **Pilot watermark:** every generated PDF carries "SPÉCIMEN — données fictives" while the pilot runs.

## 3. Data model additions (summary)
- `delivery_event` or the existing `trip_event`: `delivered` timestamp copied onto the BL's state (I1.1); a read view `delivery_state`.
- `delivery_return`: `signed` marker stays; new `document_file` (encrypted blob reference, owner document kind, hash, size, type, uploader) with an insert-only history (I1.2, I2.3).
- `invoice_line` grouped by product with a join table `invoice_line_delivery` (unique `delivery_id`: a BL is on one invoice only) (I1.4).
- `allocation` keeps its shape; a payment spreads over several invoices through several allocation rows (I1.5).
- `credit_note` details: `invoice.credit_note_of` already exists; adds the reference to the BL and the loss record, and its own `AV-YYYY-nnnnn` counter (I1.6).
- `supplier_invoice`, `supplier_invoice_line`, `supplier_invoice_match`, `supplier_invoice_acceptance`; `purchase_plan_item` becomes the payable of an approved supplier invoice (I2.1, I2.2).
- Parameters `match_qty_tolerance_bp`, `match_price_tolerance_bp`, `upload_max_bytes` in the single parameter source.
- `truck.default_driver_id`, `trip_plan.driver_override_reason` (I4).

## 4. Behaviour
### Sales chain
- I1.1 The `delivered` tracking step stamps the BL delivered with that step's instant. The order's delivered quantity is the sum of its delivered, non-cancelled, non-refused BLs.
- I1.2 "Returned signed" is recorded once; a scan may be attached at that moment or later (once).
- I1.3 The queue lists delivered BLs without an invoice line, per client. Owner and support see the amount at the order's price; office sees BL number, date, m³ and product only.
- I1.4 One action invoices the selected BLs (all of one client): lines grouped by product with the BL numbers listed, prices resolved on the server, legal mentions, "Acompte reçu" and "Net à payer" for advances received on the orders. Office sends BL ids and receives the invoice number only.
- I1.5 A payment is allocated across the client's open invoices, oldest due date first, as allocation records; the owner may direct it to a given invoice (audited). A bounce reverses its allocations with reversing rows, reopens the invoices and keeps the 30-day alert (law 71.24).
- I1.6 The avoir for rejected or returned concrete: owner only, step-up 2FA, references the invoice, the BL and the loss record; own sequence; never edits the invoice; appears in the client statement.

### Purchase chain
- I2.1 A supplier invoice is its own document linked to one purchase order and the receipts it covers.
- I2.2 Three-way match compares quantity and unit price of order, receipts and invoice per line; tolerances are parameters; a gap blocks "approve for payment" until the owner accepts it (audited); the payable comes from the approved supplier invoice.
- I2.3 The photo of the supplier invoice is an attachment (rules of §2). AI extraction is an interface behind the existing feature flag, OFF: no network call, no model call.

### Cross-cutting
- I3.1 Order-chain view: one row per order, stages ordered, planned, loaded, delivered, invoiced, paid; office and plant see quantities and stages, the paid stage is masked.
- I3.2 A related-documents panel on every document.
- I3.3 Search by document number: exact or prefix, 4 characters minimum, RLS-filtered, rate-limited, misses audited, lockout like the office doors; no free text on client names for office.
- I3.4 Server-side PDF for BL, invoice, avoir, quote and the two statements, generated on request and never stored unencrypted, legal mentions, pilot watermark, every generation audited; the BL PDF has no price.

### Dispatch (decisions 91 to 96)
- I4 Default driver on the truck, per-rotation override audited; office read-only dispatch view enforced in the database; overdue orders flagged by colour and text.

## 5. Permissions
Existing permissions are reused where the document already has one. New ones, each in `permissions.ts` with a declaration test: `delivery_files.write` (plant, office, owner, partner), `delivery_files.read` (same plus support), `supplier_invoices.write` (office blind, owner), `supplier_invoices.read` (owner, support), `supplier_invoices.approve` (owner, step-up), `credit_notes.issue_returned` (owner, step-up `ledger.credit_note`), `search.number` (all roles, results filtered), `dispatch.read_office` (office, restricted view), `documents.pdf.*` per document as the print permission it already has.

## 6. Acceptance criteria
- **AC-INT-01** A rotation whose `delivered` step is recorded marks its BL delivered with that instant; an order's delivered m³ equals the sum of its delivered BLs; a cancelled or refused load never counts. (I1.1)
- **AC-INT-02** The signed-BL return can be recorded once with or without a scan; a second record is refused as today. (I1.2)
- **AC-INT-03** A file is refused unless its content type and magic bytes both say JPEG, PNG, WebP or PDF and its size is within `upload_max_bytes`; an image is stored without EXIF; the stored blob is encrypted and sits outside any public path. (I1.2, I2.3)
- **AC-INT-04** A file is served only by an authorized route that checks the permission and RLS on the owning document; a role without access gets a 404; every upload and view writes an audit row. (I1.2, I2.3)
- **AC-INT-05** The delivered-not-invoiced queue lists exactly the delivered BLs with no invoice line, per client; owner and support see amounts; the answer for office has no money key. (I1.3)
- **AC-INT-06** One action invoices the selected BLs of one client: one line per product with the quantity summed and the BL numbers listed, prices resolved on the server, totals equal to Σ lines, legal mentions present; a BL already on an invoice is refused by a database constraint, also under concurrency. (I1.4)
- **AC-INT-07** Advances received on the orders appear as "Acompte reçu" and "Net à payer" equals total TTC minus advances; the stored invoice total is unchanged. (I1.4)
- **AC-INT-08** Office sends BL ids and receives only the invoice number; the office-doors parity and exposure tests cover the new function. (I1.4)
- **AC-INT-09** A payment is split over the client's open invoices oldest due date first, each part an allocation row, never more than the instrument or than an invoice's remainder. (I1.5)
- **AC-INT-10** The owner can direct a payment to one invoice; the override and its reason are audited; nobody else can. (I1.5)
- **AC-INT-11** A bounce reverses every allocation with a negated row, the invoices are open again and the 30-day regularization alert stays. (I1.5)
- **AC-INT-12** An avoir for returned concrete is issued only by the owner after step-up 2FA, carries the invoice, BL and loss references and an `AV-YYYY-nnnnn` number, leaves the original invoice untouched, and shows in the client statement. (I1.6)
- **AC-INT-13** A supplier invoice is linked to one purchase order and its receipts; the migration of the fake data keeps every purchase and its amounts. (I2.1)
- **AC-INT-14** Three-way match flags quantity and price gaps per line against tolerances read from parameters; with a gap, "approve for payment" is refused until the owner accepts it, the acceptance is audited; the payable exists only after approval. (I2.2)
- **AC-INT-15** The supplier invoice photo is an attachment under AC-INT-03 and 04; the extraction interface is behind the feature flag, OFF; a test proves the flag-off path makes zero outbound requests. (I2.3)
- **AC-INT-16** The order-chain view gives one row per order with the six stages; office and plant answers have no amount and the paid stage is masked. (I3.1)
- **AC-INT-17** Every document page lists its neighbours from database relations; a role that cannot open a neighbour sees its number without a link or nothing, per the role rules. (I3.2)
- **AC-INT-18** Search takes exact or prefix numbers of 4 characters or more, returns only what RLS lets the caller read, is rate-limited, audits misses and locks an actor out after repeated unknown probes; office cannot search names. (I3.3)
- **AC-INT-19** BL, invoice, avoir, quote and both statements are available as server-generated PDF with legal mentions and the pilot watermark, each generation audited, nothing stored unencrypted; the BL PDF contains no price. (I3.4)
- **AC-INT-20** A truck has a default driver; dispatch proposes it; an override per rotation requires a reason and is audited. (I4)
- **AC-INT-21** Office reads a dispatch view with truck, times, m³ and client name and no price or amount; the database refuses it any more, and the exposure test lists it. (I4)
- **AC-INT-22** An overdue order is flagged on the dispatch board by colour and by text. (I4)
- **AC-INT-23** The demo scenario walks plan, load, deliver, signed BL, invoice from BLs with an advance, payment allocated, bounce, statement, and purchase order, partial receipt, supplier invoice with a flagged gap, approval, payment; idempotent, audited as system. (Finish)
- **AC-INT-24** Every new screen is checked in fr and ar at 375 and 1280 px, Latin codes isolated, no CSP violation, no money in the HTML of roles without money.

## 7. Assumptions
Every decision taken while building is a new provisional decision in docs/DECISIONS.md (numbered from 97) and listed in CP-INTEGRATION-2.md.
