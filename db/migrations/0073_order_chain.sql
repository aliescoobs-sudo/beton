-- integration I3.1 (SPEC-integration AC-INT-16): the order chain, one row per order with the stages ordered, planned, loaded,
-- delivered, invoiced and paid. Quantities only (litres): no price, no total, no amount anywhere. The stage "paid" is the payment
-- state of the order and is given to the owner and support only: office, plant and partner get NULL there. One reviewed
-- SECURITY DEFINER function, because office cannot read orders (D81) and the plant reads them only through a view of operational
-- fields; every role of the company may ask, and no role gets more than quantities and stages.
CREATE FUNCTION public.order_chain()
RETURNS TABLE (order_id uuid, code text, client_code text, type_code text, order_date date, delivery_date date, ordered_l integer,
               planned_l bigint, loaded_l bigint, delivered_l bigint, invoiced_l bigint, paid_state text, cancelled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_money boolean;
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'support', 'partner', 'plant', 'office', 'system') THEN
    RAISE EXCEPTION 'order_chain: role % may not read the order chain', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_money := ctx.role() IN ('owner', 'support', 'system');
  RETURN QUERY
  SELECT o.id, o.code, c.code, t.code, o.order_date, o.delivery_date, o.volume_l,
         coalesce((SELECT sum(p.volume_l) FROM public.trip_plan p
                    WHERE p.order_id = o.id AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)), 0)::bigint,
         coalesce((SELECT sum(d.volume_l) FROM public.delivery d WHERE d.order_id = o.id), 0)::bigint,
         coalesce((SELECT sum(d.volume_l) FROM public.delivery d
                    WHERE d.order_id = o.id AND d.reverses_id IS NULL
                      AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
                      AND EXISTS (SELECT 1 FROM public.delivery_delivered g WHERE g.delivery_id = d.id)
                      AND NOT EXISTS (SELECT 1 FROM public.delivery_loss l WHERE l.delivery_id = d.id AND l.volume_l >= d.volume_l)), 0)::bigint,
         coalesce((SELECT sum(l.volume_l) FROM public.invoice_line l
                     JOIN public.invoice i ON i.id = l.invoice_id AND i.credit_note_of IS NULL
                     JOIN public.delivery d ON d.id = l.delivery_id
                    WHERE d.order_id = o.id AND NOT EXISTS (SELECT 1 FROM public.invoice cn WHERE cn.credit_note_of = i.id)), 0)::bigint,
         CASE WHEN NOT v_money OR EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id) THEN NULL
              WHEN coalesce((SELECT sum(a.amount_centimes) FROM public.allocation a JOIN public.payment_plan_item pi ON pi.id = a.payment_plan_item_id
                              WHERE pi.order_id = o.id), 0) >= o.total_ttc_centimes THEN 'paid'
              WHEN coalesce((SELECT sum(a.amount_centimes) FROM public.allocation a JOIN public.payment_plan_item pi ON pi.id = a.payment_plan_item_id
                              WHERE pi.order_id = o.id), 0) > 0 THEN 'partial'
              ELSE 'unpaid' END,
         EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
    FROM public.sales_order o
    JOIN public.client c ON c.id = o.client_id
    JOIN public.concrete_type t ON t.id = o.concrete_type_id
   WHERE o.reverses_id IS NULL
   ORDER BY o.delivery_date DESC, o.code DESC
   LIMIT 300;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.order_chain() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.order_chain() TO belgobeton_app;
