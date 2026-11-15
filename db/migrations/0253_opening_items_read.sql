-- T19c B1 (D245, D246): the per-invoice opening items are READ by statements, the reminder list and the aging screen. No data (decision 79). Forward migration.
-- opening_open_item stays doors-only (no app policy): this one door answers the items of the given parties to the roles that read that SIDE of the money:
--   owner, app_admin, support: both sides; office_sales (the Responsable): clients only; office_purchases (the Assistante): suppliers only (same split as 0239).
-- Actor first, then the side, then the read. Insert-only tables, nothing is written here.
CREATE FUNCTION public.opening_items_read(p_kind text, p_ids uuid[])
  RETURNS TABLE(o_party uuid, o_invoice_number text, o_invoice_date date, o_due_date date, o_amount bigint, o_balance bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('opening_items_read');
  IF p_kind IS NULL OR p_kind <> ALL (ARRAY['client', 'supplier']) THEN
    RAISE EXCEPTION 'opening_items_read: client or supplier' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (v_role IN ('owner', 'app_admin', 'support')
          OR (v_role = 'office_sales' AND p_kind = 'client')
          OR (v_role = 'office_purchases' AND p_kind = 'supplier')) THEN
    RAISE EXCEPTION 'opening_items_read: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT coalesce(o.client_id, o.supplier_id), o.invoice_number, o.invoice_date, o.due_date, o.amount_centimes, o.balance_centimes
    FROM public.opening_open_item o
   WHERE coalesce(o.client_id, o.supplier_id) = ANY (coalesce(p_ids, ARRAY[]::uuid[]))
     AND ((p_kind = 'client' AND o.client_id IS NOT NULL) OR (p_kind = 'supplier' AND o.supplier_id IS NOT NULL))
   ORDER BY o.due_date, o.invoice_number;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.opening_items_read(text, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.opening_items_read(text, uuid[]) TO belgobeton_app;
