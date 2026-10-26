-- integration I1.3 (SPEC-integration AC-INT-05): the "delivered, not invoiced" queue. Delivered loads (not cancelled, not wholly
-- refused) that no live invoice carries, with their client and product and nothing else: no price, no total, no order code.
-- One reviewed SECURITY DEFINER function answers owner, support and office, because office cannot read orders (D81, D84) and
-- the client of a load is on its order. Amounts for the owner and support are computed by the service from the order's price.
CREATE FUNCTION public.invoice_queue()
RETURNS TABLE (delivery_id uuid, bl_no text, load_date date, delivered_at timestamptz, volume_l integer, client_id uuid,
               client_code text, client_name text, type_code text, type_label text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'office', 'support', 'system') THEN
    RAISE EXCEPTION 'invoice_queue: role % may not read the invoicing queue', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT d.id, d.bl_no, d.load_date, g.at, d.volume_l, c.id, c.code, c.name, t.code, t.label
    FROM public.delivery d
    JOIN public.delivery_delivered g ON g.delivery_id = d.id
    JOIN public.sales_order o ON o.id = d.order_id
    JOIN public.client c ON c.id = o.client_id
    JOIN public.concrete_type t ON t.id = o.concrete_type_id
   WHERE d.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_loss l WHERE l.delivery_id = d.id AND l.volume_l >= d.volume_l)
     AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.invoice_line l JOIN public.invoice i ON i.id = l.invoice_id
        WHERE l.delivery_id = d.id AND i.credit_note_of IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.invoice cn WHERE cn.credit_note_of = i.id))
   ORDER BY c.code, d.load_date, d.bl_no;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.invoice_queue() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.invoice_queue() TO belgobeton_app;
