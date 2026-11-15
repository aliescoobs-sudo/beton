-- T19 item 4: the PO numbers of orders by order CODE, for the invoice an office role prints (invoice_print returns the codes of the orders, not their ids). Same roles as order_extras. No data.
CREATE FUNCTION public.order_client_pos(p_codes text[]) RETURNS TABLE(o_code text, o_client_po text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('order_client_pos');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office', 'office_sales', 'office_purchases', 'plant', 'plant_manager', 'accountant', 'support']) THEN
    RAISE EXCEPTION 'order_client_pos: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT o.code, x.client_po FROM public.sales_order o JOIN public.order_extra x ON x.order_id = o.id WHERE o.code = ANY (p_codes) AND x.client_po IS NOT NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.order_client_pos(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.order_client_pos(text[]) TO belgobeton_app;
