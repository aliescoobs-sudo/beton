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
- [ ] I1.4 Invoice from selected BLs, grouped by product, advances, one-invoice-per-BL constraint (AC-INT-06, 07, 08)
- [ ] I1.5 Allocation across all open invoices, owner override, bounce (AC-INT-09, 10, 11)
- [ ] I1.6 Avoir for rejected or returned concrete (AC-INT-12)

### Wave I2: purchase chain
- [ ] I2.1 Supplier invoice as its own document (AC-INT-13)
- [ ] I2.2 Three-way match, acceptance, payable from the approved invoice (AC-INT-14)
- [ ] I2.3 Supplier invoice photo, AI extraction interface off (AC-INT-15)

### Wave I3: cross-cutting
- [ ] I3.1 Order-chain view (AC-INT-16)
- [ ] I3.2 Related-documents panel (AC-INT-17)
- [ ] I3.3 Search by number (AC-INT-18)
- [ ] I3.4 Server-side PDF (AC-INT-19)

### Wave I4: decisions 91 to 96
- [ ] I4.1 Default driver per truck, audited override (AC-INT-20)
- [ ] I4.2 Office read-only dispatch view (AC-INT-21)
- [ ] I4.3 Overdue orders flagged (AC-INT-22)

### Wave I5: documents only, no code
- [ ] docs/SPEC-assistant.md
- [ ] docs/REFERENCE-MAP.md

### Finish
- [ ] db:scenario walk and DEMO.md (AC-INT-23)
- [ ] Full regression: unit, integration, e2e on an idle machine (single worker if load makes it flaky, no raised timeouts)
- [ ] Re-run of the CP-INTEGRATION table with the new verdicts (below)
- [ ] Unfinished list and new provisional decisions (below)

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
Filled at the end (re-run of the CP-INTEGRATION table).

## Not finished
Filled at the end.

## New provisional decisions
Filled as they are taken (DECISIONS 97 onward): 97 (delivered), 98 (delivered quantity), 99 (stored documents), 100 (signed BL and its scan), 101 (invoicing queue).
