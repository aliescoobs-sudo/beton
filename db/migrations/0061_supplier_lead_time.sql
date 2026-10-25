-- operations O12 (SPEC-operations §7.2, AC-OPS-20): how long a supplier takes from order to receipt, in calendar days. Optional:
-- without it the reorder suggestion uses the parameter `purchase_lead_days`. Not money. Owner, partner and office edit it with
-- the rest of the supplier (the table grants UPDATE as before); the column is audited with the row.
ALTER TABLE public.supplier ADD COLUMN lead_time_days integer
  CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 120);
