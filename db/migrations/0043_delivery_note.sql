-- operations O7 (AC-OPS-11): the data of a delivery note (bon de livraison). Office is blind on orders and plant may not
-- read clients, yet both print the BL, so the note is served by one reviewed SECURITY DEFINER function that returns
-- quantities, names and places only: no price, total, plan, payment or client contact. The client's name is withheld
-- from plant (DECISIONS 81: plant sees the client code only); the code is on the note either way.
CREATE FUNCTION public.delivery_note(p_delivery uuid)
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
           (d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)),
           o.code, c.code,
           CASE WHEN ctx.role() = 'plant' THEN NULL ELSE c.name END,
           s.label, z.name, t.code, t.label, k.code, k.plate
      FROM public.delivery d
      JOIN public.sales_order o ON o.id = d.order_id
      JOIN public.client c ON c.id = o.client_id
      LEFT JOIN public.client_site s ON s.id = o.site_id
      LEFT JOIN public.zone z ON z.id = o.zone_id
      JOIN public.concrete_type t ON t.id = o.concrete_type_id
      JOIN public.truck k ON k.id = d.truck_id
     WHERE d.id = p_delivery;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.delivery_note(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.delivery_note(uuid) TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY zone_definer_read ON public.zone FOR SELECT TO belgobeton_migrator USING (true);
