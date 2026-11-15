-- T19 item 1 (D245 "D-A"): each office role reads the money of ITS OWN side and nothing else. No data (decision 79). Forward migration.
--   office_sales    (the Responsable): client balances, client statements, client payment instruments and receipts: rows of the CLIENT side only.
--   office_purchases (the Assistante): supplier balances, statements, outgoing payments, cash (the cash accounts only, never a bank account).
-- Both office roles share the policy role 'office' (ctx.role()), so these policies read the REAL role, ctx.actor_role(), which is itself admitted-actor checked (0220).
-- Each policy is an ADDITIONAL permissive SELECT policy named <table>_office_<side>_read; the owner / support policies and every INSERT policy are untouched.
-- Not opened to any office role: costs, margins, price grids, selling and purchase prices, the finance schema, any bank account, payroll-like data, the audit log of money tables.
-- Reads by an office role are audited by the application (recordMoneyView, extended in the same task): the database cannot log a plain read.
-- invoice_payment_state: the gate also admits office_sales (the same figures the owner reads, one side).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('opening_party_balance', 'office_sales',     'client_id IS NOT NULL'),
    ('ledger_opening',        'office_sales',     'true'),
    ('sales_order',           'office_sales',     'true'),
    ('invoice',               'office_sales',     'true'),
    ('avoir',                 'office_sales',     'true'),
    ('payment_plan_item',     'office_sales',     $p$direction = 'in'$p$),
    ('payment_instrument',    'office_sales',     $p$direction = 'in'$p$),
    ('instrument_event',      'office_sales',     $p$EXISTS (SELECT 1 FROM public.payment_instrument i WHERE i.id = instrument_id AND i.direction = 'in')$p$),
    ('allocation',            'office_sales',     $p$EXISTS (SELECT 1 FROM public.payment_instrument i WHERE i.id = instrument_id AND i.direction = 'in')$p$),
    ('opening_party_balance', 'office_purchases', 'supplier_id IS NOT NULL'),
    ('ledger_opening',        'office_purchases', 'true'),
    ('purchase',              'office_purchases', 'true'),
    ('purchase_plan_item',    'office_purchases', 'true'),
    ('supplier_invoice',      'office_purchases', 'true'),
    ('supplier_invoice_event','office_purchases', 'true'),
    ('payment_instrument',    'office_purchases', $p$direction = 'out'$p$),
    ('instrument_event',      'office_purchases', $p$EXISTS (SELECT 1 FROM public.payment_instrument i WHERE i.id = instrument_id AND i.direction = 'out')$p$),
    ('allocation',            'office_purchases', $p$EXISTS (SELECT 1 FROM public.payment_instrument i WHERE i.id = instrument_id AND i.direction = 'out')$p$),
    ('money_account',         'office_purchases', $p$kind = 'cash'$p$),
    ('opening_balance',       'office_purchases', $p$EXISTS (SELECT 1 FROM public.money_account a WHERE a.id = account_id AND a.kind = 'cash')$p$),
    ('money_movement',        'office_purchases', $p$EXISTS (SELECT 1 FROM public.money_account a WHERE a.id = account_id AND a.kind = 'cash')$p$)
  ) AS v(tbl, who, pred) LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app USING (ctx.actor_role() = %L AND (%s))',
                   r.tbl || '_' || r.who || '_read', r.tbl, r.who, r.pred);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.invoice_payment_state() RETURNS TABLE (invoice_id uuid, total_ttc_centimes bigint, paid_centimes bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR NOT (ctx.role() IN ('owner', 'support', 'system') OR ctx.actor_role() = 'office_sales') THEN
    RAISE EXCEPTION 'invoice_payment_state: role % may not read payment states', coalesce(ctx.actor_role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT i.id, i.total_ttc_centimes, coalesce(sum(s.paid), 0)::bigint
    FROM public.invoice i LEFT JOIN public._invoice_shares() s ON s.inv_id = i.id
   WHERE i.credit_note_of IS NULL AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id)
   GROUP BY i.id, i.total_ttc_centimes;
END $$;
