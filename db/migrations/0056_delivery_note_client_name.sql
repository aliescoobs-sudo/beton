-- Review of CP-OPS-1-3, point 6 (DECISIONS 83, provisional, to confirm with the owner): the plant may see and print the client's
-- name and the site on the delivery note, because the client signs it. Still no contact, no price, no total, no payment.
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
           (d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)),
           o.code, c.code, c.name, s.label, z.name, t.code, t.label, k.code, k.plate
      FROM public.delivery d
      JOIN public.sales_order o ON o.id = d.order_id
      JOIN public.client c ON c.id = o.client_id
      LEFT JOIN public.client_site s ON s.id = o.site_id
      LEFT JOIN public.zone z ON z.id = o.zone_id
      JOIN public.concrete_type t ON t.id = o.concrete_type_id
      JOIN public.truck k ON k.id = d.truck_id
     WHERE d.id = p_delivery;
END $$;
