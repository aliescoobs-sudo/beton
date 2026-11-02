-- §16.1 (REQUIREMENTS-V1 §3, §4): the reference average prices are visible to every internal non-field account, nothing else
-- about money is. One reviewed door returns the CURRENT list selling price per concrete type and the CURRENT purchase price
-- per component (latest version in force today). It returns no balance, no order, no client price override.
CREATE FUNCTION public.reference_prices(p_today date) RETURNS TABLE(kind text, item_code text, item_name text, price_centimes bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN
     ('owner', 'app_admin', 'office', 'office_sales', 'office_purchases', 'plant', 'plant_manager', 'support') THEN
    RAISE EXCEPTION 'reference_prices: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT 'sell'::text, t.code, t.label,
         (SELECT s.price_ht_per_m3_centimes FROM public.selling_price s
           WHERE s.concrete_type_id = t.id AND s.client_id IS NULL AND s.effective_from <= p_today
           ORDER BY s.effective_from DESC LIMIT 1)
    FROM public.concrete_type t
   WHERE EXISTS (SELECT 1 FROM public.selling_price s WHERE s.concrete_type_id = t.id AND s.client_id IS NULL AND s.effective_from <= p_today)
  UNION ALL
  SELECT 'buy'::text, c.code, c.name_fr,
         (SELECT avg(x.price_ht_centimes)::bigint FROM (
            SELECT DISTINCT ON (p.supplier_id) p.price_ht_centimes FROM public.purchase_price p
             WHERE p.component_id = c.id AND p.effective_from <= p_today
             ORDER BY p.supplier_id, p.effective_from DESC) x)
    FROM public.component c
   WHERE EXISTS (SELECT 1 FROM public.purchase_price p WHERE p.component_id = c.id AND p.effective_from <= p_today)
  ORDER BY 1, 2;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.reference_prices(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reference_prices(date) TO belgobeton_app;
