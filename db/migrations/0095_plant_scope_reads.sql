-- Batch A gap (CP-PROD-PLAN, R2; DECISIONS 150): three older SECURITY DEFINER reads were not scoped to a plant manager's plant. A plant manager
-- now gets the rows of their own plant only from the order chain, the delivery note and the dispatch board; every other role is unchanged.
CREATE OR REPLACE FUNCTION public.order_chain()
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
   WHERE o.reverses_id IS NULL AND (ctx.actor_role() <> 'plant_manager' OR o.plant_id IS NOT DISTINCT FROM ctx.plant_scope())
   ORDER BY o.delivery_date DESC, o.code DESC
   LIMIT 300;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.dispatch_office(p_date date)
RETURNS TABLE (trip_id uuid, trip_date date, seq integer, truck_code text, truck_plate text, client_name text, site_label text,
               zone_name text, volume_l integer, load_min integer, depart_min integer, arrive_min integer, unload_end_min integer,
               back_min integer, step text, bl_no text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('office', 'owner', 'partner', 'plant', 'support') THEN
    RAISE EXCEPTION 'dispatch_office: role % may not read the dispatch', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT p.id, p.trip_date, p.seq, t.code, t.plate, c.name, s.label, z.name, p.volume_l, p.load_min, p.depart_min, p.arrive_min,
         p.unload_end_min, p.back_min,
         (SELECT e.step FROM public.trip_event e WHERE e.trip_id = p.id ORDER BY e.at DESC, e.created_at DESC LIMIT 1),
         (SELECT d.bl_no FROM public.trip_event e JOIN public.delivery d ON d.id = e.delivery_id WHERE e.trip_id = p.id AND e.step = 'loaded')
    FROM public.trip_plan p
    JOIN public.truck t ON t.id = p.truck_id
    JOIN public.sales_order o ON o.id = p.order_id
    JOIN public.client c ON c.id = o.client_id
    LEFT JOIN public.client_site s ON s.id = o.site_id
    LEFT JOIN public.zone z ON z.id = o.zone_id
   WHERE p.trip_date = p_date AND (ctx.actor_role() <> 'plant_manager' OR o.plant_id IS NOT DISTINCT FROM ctx.plant_scope())
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
   ORDER BY p.load_min, t.code, p.seq
   LIMIT 300;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.delivery_note(p_delivery uuid)
RETURNS TABLE (
  bl_no text, load_date date, loaded_at timestamptz, volume_l integer, cancelled boolean,
  order_code text, client_code text, client_name text, site_label text, zone_name text,
  type_code text, type_label text, truck_code text, truck_plate text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant', 'support') THEN
    RAISE EXCEPTION 'delivery_note: role % may not print a delivery note', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.bl_no, d.load_date, d.loaded_at, d.volume_l,
           (d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
            OR EXISTS (SELECT 1 FROM public.cancellation_case c WHERE c.delivery_id = d.id AND c.decision IN ('redirect', 'loss'))),
           o.code, c.code, c.name, s.label, z.name, t.code, t.label, k.code, k.plate
      FROM public.delivery d
      JOIN public.sales_order o ON o.id = d.order_id
      JOIN public.client c ON c.id = o.client_id
      LEFT JOIN public.client_site s ON s.id = o.site_id
      LEFT JOIN public.zone z ON z.id = o.zone_id
      JOIN public.concrete_type t ON t.id = o.concrete_type_id
      JOIN public.truck k ON k.id = d.truck_id
     WHERE d.id = p_delivery AND (ctx.actor_role() <> 'plant_manager' OR o.plant_id IS NOT DISTINCT FROM ctx.plant_scope());
END $$;
