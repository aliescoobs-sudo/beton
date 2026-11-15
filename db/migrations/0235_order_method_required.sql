-- T17 G7 (D239 d): every NEW order carries a discharge method. The 11-argument create_order door now refuses: its body moves, unchanged, to create_order__core (no grant to any login), and
-- create_order_with_method (0232) calls the core after validating the method. Legacy rows are untouched (a NULL method stays NULL: "method not recorded", never counted as GOULOTTE).
-- No data in this migration (decision 79). Forward migration.
ALTER FUNCTION public.create_order(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer) RENAME TO create_order__core;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.create_order__core(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer) FROM PUBLIC, belgobeton_app;
--> statement-breakpoint
CREATE FUNCTION public.create_order(p_client uuid, p_site uuid, p_zone uuid, p_type uuid, p_volume_l integer, p_delivery date, p_today date, p_brought_by uuid, p_quote uuid, p_plan jsonb, p_vat_default integer)
  RETURNS TABLE(code text, id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('create_order');
  RAISE EXCEPTION 'create_order: a new order needs a discharge method (GOULOTTE or POMPE); use create_order_with_method' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.create_order(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_order(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer) TO belgobeton_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.create_order_with_method(p_client uuid, p_site uuid, p_zone uuid, p_type uuid, p_volume_l integer, p_delivery date, p_today date, p_brought_by uuid, p_quote uuid, p_plan jsonb, p_vat_default integer, p_method text)
  RETURNS TABLE(code text, id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('create_order_with_method');
  IF p_method IS NULL OR p_method <> ALL (ARRAY['GOULOTTE', 'POMPE']) THEN
    RAISE EXCEPTION 'create_order_with_method: the discharge method is GOULOTTE or POMPE' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.order_discharge_method', p_method, true);
  RETURN QUERY SELECT r.code, r.id FROM public.create_order__core(p_client, p_site, p_zone, p_type, p_volume_l, p_delivery, p_today, p_brought_by, p_quote, p_plan, p_vat_default) r;
  PERFORM set_config('app.order_discharge_method', '', true);
END $$;
