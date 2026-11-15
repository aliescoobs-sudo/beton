-- Grants of belgobeton_seed, the login role of the pilot seed (scripts/seed-pilot.ts). Not a migration: the role exists
-- only where db:bootstrap ran with SIMULATION_ENABLED=true and neither REAL_DATA nor production, so runMigrations applies
-- this file (as the migrator, idempotent) only when the role is there.
-- The role reads and inserts master data and nothing else: no UPDATE (except the code counter), no DELETE, no TRUNCATE.
-- Rows are still audited (the audit trigger runs as the inserting role: hence audit.record), and RLS still applies:
-- the policies below accept only the request context role 'system', which the seed sets.
GRANT USAGE ON SCHEMA public, ctx, audit TO belgobeton_seed;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ctx TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION audit.record(text, text, text, jsonb, jsonb, text) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.next_code(text, integer) TO belgobeton_seed;
-- The training seed (T1) runs the scenario with a plant active: the arrival is confirmed for the plant before the office records it.
GRANT EXECUTE ON FUNCTION public.confirm_receipt_at_plant(uuid, text) TO belgobeton_seed;

GRANT SELECT, INSERT, UPDATE ON public.code_sequence TO belgobeton_seed;
DROP POLICY IF EXISTS seed_all ON public.code_sequence;
CREATE POLICY seed_all ON public.code_sequence FOR ALL TO belgobeton_seed
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');

DO $$
DECLARE
  t text;
  -- Tables whose rows carry created_by: the seed writes them as the request user (the system actor).
  stamped text[] := ARRAY['recette', 'purchase_price', 'selling_price'];
BEGIN
  FOREACH t IN ARRAY ARRAY['zone', 'client', 'supplier', 'component', 'purchase_unit', 'concrete_type', 'truck',
                           'recette', 'recette_line', 'purchase_price', 'selling_price'] LOOP
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO belgobeton_seed', t);
    EXECUTE format('DROP POLICY IF EXISTS seed_read ON public.%I', t);
    EXECUTE format('CREATE POLICY seed_read ON public.%I FOR SELECT TO belgobeton_seed USING (ctx.role() = ''system'')', t);
    EXECUTE format('DROP POLICY IF EXISTS seed_insert ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY seed_insert ON public.%I FOR INSERT TO belgobeton_seed WITH CHECK (ctx.role() = ''system''%s)',
      t, CASE WHEN t = ANY (stamped) THEN ' AND created_by = ctx.user_id()' ELSE '' END);
  END LOOP;
END $$;

-- The pilot scenario (ledger L34): the ledger tables the scenario fills, with the same rules as above (SELECT and INSERT
-- only, request context 'system', rows stamped with the system actor). The database triggers (price guard, plan balance,
-- lifecycle guard, allocation sums, the movement written by a clearing) still run for every row.
GRANT EXECUTE ON FUNCTION public.next_doc_number(text, integer, integer) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.resolve_selling_price(uuid, uuid, date) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.resolve_order_price(uuid, uuid, date) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.ledger_parameter(text) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.default_cash_account() TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.record_receipt(uuid, date) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.record_receipt_lines(uuid, date, jsonb, boolean) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.create_invoice(text, uuid[], date, date) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.allocate_to_purchase(uuid, text) TO belgobeton_seed;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['money_account', 'opening_balance', 'ledger_opening', 'opening_party_balance', 'sales_order',
                           'payment_plan_item', 'payment_instrument', 'instrument_event', 'allocation', 'purchase',
                           'purchase_line', 'purchase_plan_item', 'stock_threshold', 'stock_count_tolerance', 'invoice', 'invoice_line', 'delivery', 'delivery_return', 'stock_movement',
                           'company_profile', 'quote', 'driver', 'trip_plan', 'trip_event', 'fuel_fill', 'fuel_purchase',
                           'delivery_loss', 'delivery_delivered'] LOOP
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO belgobeton_seed', t);
    EXECUTE format('DROP POLICY IF EXISTS seed_read ON public.%I', t);
    EXECUTE format('CREATE POLICY seed_read ON public.%I FOR SELECT TO belgobeton_seed USING (ctx.role() = ''system'')', t);
    EXECUTE format('DROP POLICY IF EXISTS seed_insert ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY seed_insert ON public.%I FOR INSERT TO belgobeton_seed WITH CHECK (ctx.role() = ''system'' AND created_by = ctx.user_id())', t);
  END LOOP;
END $$;

-- Movements are written by the clearing trigger; the seed adds only the bank fees of its bounced cheques (expenses).
GRANT SELECT, INSERT ON public.money_movement TO belgobeton_seed;
DROP POLICY IF EXISTS seed_read ON public.money_movement;
CREATE POLICY seed_read ON public.money_movement FOR SELECT TO belgobeton_seed USING (ctx.role() = 'system');
DROP POLICY IF EXISTS seed_insert_expense ON public.money_movement;
CREATE POLICY seed_insert_expense ON public.money_movement FOR INSERT TO belgobeton_seed
  WITH CHECK (ctx.role() = 'system' AND created_by = ctx.user_id() AND source = 'expense' AND reverses_id IS NULL AND amount_centimes < 0);

-- Operations second wave: the scenario gives the suppliers a lead time (the only column it updates, system context only).
GRANT UPDATE (lead_time_days) ON public.supplier TO belgobeton_seed;
DROP POLICY IF EXISTS seed_update_lead_time ON public.supplier;
CREATE POLICY seed_update_lead_time ON public.supplier FOR UPDATE TO belgobeton_seed
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');

-- Integration walk (CP-INTEGRATION-2, AC-INT-23): the scenario uses the application's own doors, executed in the system request
-- context, and reads the supplier invoice it just made to find its id. Same rules as above: no UPDATE, no DELETE, rows stamped
-- with the system actor; the doors check the role themselves.
GRANT EXECUTE ON FUNCTION public.create_invoice_from_deliveries(uuid[], date, date) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.allocate_to_client(uuid, text) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.create_supplier_invoice(text, text, date, date, jsonb, uuid[], date) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.accept_supplier_invoice_gaps(uuid, text) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.approve_supplier_invoice(uuid, jsonb) TO belgobeton_seed;
GRANT EXECUTE ON FUNCTION public.allocate_to_supplier_invoice(uuid, text) TO belgobeton_seed;
GRANT SELECT ON public.supplier_invoice TO belgobeton_seed;
DROP POLICY IF EXISTS seed_read ON public.supplier_invoice;
CREATE POLICY seed_read ON public.supplier_invoice FOR SELECT TO belgobeton_seed USING (ctx.role() = 'system');
-- The scenario gives the first trucks their default driver (the only truck column it updates, system context only).
GRANT UPDATE (default_driver_id) ON public.truck TO belgobeton_seed;
DROP POLICY IF EXISTS seed_update_default_driver ON public.truck;
CREATE POLICY seed_update_default_driver ON public.truck FOR UPDATE TO belgobeton_seed
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');

-- The scenario asks whether a plant is active (then a receipt needs the plant's confirmation first): read-only, as the system actor.
GRANT SELECT ON public.plant TO belgobeton_seed;
DROP POLICY IF EXISTS seed_read ON public.plant;
CREATE POLICY seed_read ON public.plant FOR SELECT TO belgobeton_seed USING (ctx.role() = 'system');
