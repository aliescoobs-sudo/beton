-- integration I4.2 (AC-INT-21, decision 91 as answered by Ali): office reads the day's rotations read-only, to answer "where is my
-- truck": truck, times, litres, client name, the step the rotation has reached, and the BL number once loaded. Never a price, a
-- total, a payment or an order number. Office cannot read trip_plan, trip_event, sales_order or delivery directly (D81, the policies
-- of 0058, 0059): this one reviewed SECURITY DEFINER function is the whole of what it gets, and the exposure test lists it.
-- Roles that already read the plan (owner, partner, plant, support) may call it too; nobody else, no anonymous session.
CREATE FUNCTION public.dispatch_office(p_date date)
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
   WHERE p.trip_date = p_date
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
   ORDER BY p.load_min, t.code, p.seq
   LIMIT 300;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.dispatch_office(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.dispatch_office(date) TO belgobeton_app;
