-- T19 item 4: the partner role reads delivery notes too (deliveries.read), so it may read the PO printed on them. Same doors as 0247 and 0248 with one more role. No data.
CREATE OR REPLACE FUNCTION public.order_extras(p_orders uuid[])
  RETURNS TABLE(o_order_id uuid, o_client_po text, o_commercial text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('order_extras');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office', 'office_sales', 'office_purchases', 'plant', 'plant_manager', 'accountant', 'partner', 'support']) THEN
    RAISE EXCEPTION 'order_extras: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT x.order_id, x.client_po, x.commercial FROM public.order_extra x WHERE x.order_id = ANY (p_orders);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.order_client_pos(p_codes text[]) RETURNS TABLE(o_code text, o_client_po text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('order_client_pos');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office', 'office_sales', 'office_purchases', 'plant', 'plant_manager', 'accountant', 'partner', 'support']) THEN
    RAISE EXCEPTION 'order_client_pos: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT o.code, x.client_po FROM public.sales_order o JOIN public.order_extra x ON x.order_id = o.id WHERE o.code = ANY (p_codes) AND x.client_po IS NOT NULL;
END $$;
