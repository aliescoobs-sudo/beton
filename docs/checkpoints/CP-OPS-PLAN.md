# CP-OPS-PLAN: operations plan (no code)

Written 2026-10-24 on the owner's brief. Documents only: [tasks/plan-operations.md](../../tasks/plan-operations.md) and [tasks/todo-operations.md](../../tasks/todo-operations.md).

## What the plan covers
Deliveries per order with a delivery note (BL) without prices; stock movements computed from the recette in force on the load date (cement, sand, gravel, water, admixture per m³) and stored as facts; supplier receipts adding stock; stock levels and thresholds; the end-to-end flow (order → load → stock down → invoice → cheque → cash) with role-filtered effects. Eight core tasks (O1–O8), three checkpoints.

## Deviations from the brief and decisions to confirm
- The brief asked for this note at CP-L4. The owner then moved the operations core forward, so it is written now, before CP-L3.
- Reconciliation with the plant software (ARCO GOLD TWO) is an interface and a sample format only, and stays with the `reconciliation` module: the real export format is still unknown (open question 3). Nothing in the core depends on it.
- The core needs two ledger tasks earlier than planned: L17 (invoice lines from deliveries) for the end-to-end flow, and L20/L21 (purchase and receipt) for stock coming in.
- One grant change: `next_doc_number` will accept `plant` **for the `BL` prefix only** (the plant creates loads, A11). It touches a security-relevant function the ledger plan specifies the callers of, so it is flagged here and tested (plant cannot number CMD, FA or ACH).
- Stock valuation and margin are money and stay out of the core (owner and support only, later).

## Open points for the owner
1. Low-stock thresholds per component (pilot values are assumptions).
2. A load beyond the order's volume is refused in the core (could be a warning).
3. Plant software export format.
