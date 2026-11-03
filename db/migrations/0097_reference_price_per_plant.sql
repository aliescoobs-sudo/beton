-- C3 (REQUIREMENTS-V1 §4, revisits DECISIONS 140): the reference (list) selling price can be set per plant.
-- plant_id NULL = every plant (all existing rows). A plant row wins over the all-plants row for an order of that plant; a client's
-- own override still wins over both (it is a per-client agreement). A client override stays plant-agnostic, and so do quotes.
ALTER TABLE public.selling_price ADD COLUMN plant_id uuid REFERENCES public.plant (id);
--> statement-breakpoint
ALTER TABLE public.selling_price ADD CONSTRAINT selling_price_plant_list_only CHECK (plant_id IS NULL OR client_id IS NULL);
--> statement-breakpoint
ALTER TABLE public.selling_price DROP CONSTRAINT selling_price_concrete_type_id_client_id_effective_from_key;
--> statement-breakpoint
ALTER TABLE public.selling_price ADD CONSTRAINT selling_price_scope_effective_key
  UNIQUE NULLS NOT DISTINCT (concrete_type_id, client_id, plant_id, effective_from);
--> statement-breakpoint
-- Versions of one (type, client, plant) scope are strictly increasing in time (as before, the scope now includes the plant).
CREATE OR REPLACE FUNCTION public.selling_price_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_last date;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.concrete_type_id::text || ':' || coalesce(NEW.client_id::text, 'list') || ':' || coalesce(NEW.plant_id::text, 'all'), 2));
  SELECT max(effective_from) INTO v_last FROM public.selling_price
   WHERE concrete_type_id = NEW.concrete_type_id AND client_id IS NOT DISTINCT FROM NEW.client_id
     AND plant_id IS NOT DISTINCT FROM NEW.plant_id;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'selling_price: effective_from must be after the previous version (%)', v_last
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- The internal lookup knows the plant. Called with three arguments (quotes, older callers) it reads the all-plants prices only.
DROP FUNCTION public._price_in_force(uuid, uuid, date);
--> statement-breakpoint
CREATE FUNCTION public._price_in_force(p_type uuid, p_client uuid, p_date date, p_plant uuid DEFAULT NULL)
RETURNS TABLE (id uuid, price_ht_per_m3_centimes bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT sp.id, sp.price_ht_per_m3_centimes FROM public.selling_price sp
   WHERE sp.concrete_type_id = p_type AND sp.effective_from <= p_date AND (sp.client_id = p_client OR sp.client_id IS NULL)
     AND (sp.plant_id IS NULL OR sp.plant_id = p_plant)
   ORDER BY (sp.client_id IS NOT NULL) DESC, (sp.plant_id IS NOT NULL) DESC, sp.effective_from DESC
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._price_in_force(uuid, uuid, date, uuid) FROM PUBLIC;
--> statement-breakpoint
-- The plant a new order will get: the request's plant, else the only active plant (the same rule as plant_fill).
CREATE FUNCTION public._order_plant() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(ctx.plant_id(),
                  (SELECT CASE WHEN count(*) = 1 THEN (array_agg(p.id))[1] END FROM public.plant p WHERE p.status = 'active'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._order_plant() FROM PUBLIC;
--> statement-breakpoint
-- The price an order of the request's plant is made at (owner and system, like resolve_selling_price).
CREATE FUNCTION public.resolve_order_price(p_type uuid, p_client uuid, p_date date)
RETURNS TABLE (id uuid, price_ht_per_m3_centimes bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'system') THEN
    RAISE EXCEPTION 'resolve_order_price: role % may not resolve a price', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM public._price_in_force(p_type, p_client, p_date, public._order_plant());
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_order_price(uuid, uuid, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_order_price(uuid, uuid, date) TO belgobeton_app;
--> statement-breakpoint
-- The order guard (AFTER insert: the row already has its plant) and create_order look the price up for the order's plant.
DO $$
DECLARE v text;
BEGIN
  v := pg_get_functiondef('public.sales_order_price_guard()'::regprocedure);
  IF position('_price_in_force(NEW.concrete_type_id, NEW.client_id, NEW.order_date)' IN v) = 0 THEN RAISE EXCEPTION 'sales_order_price_guard changed shape'; END IF;
  EXECUTE replace(v, '_price_in_force(NEW.concrete_type_id, NEW.client_id, NEW.order_date)', '_price_in_force(NEW.concrete_type_id, NEW.client_id, NEW.order_date, NEW.plant_id)');
  v := pg_get_functiondef('public.create_order__inner(uuid,uuid,uuid,uuid,integer,date,date,uuid,uuid,jsonb,integer)'::regprocedure);
  IF position('_price_in_force(p_type, p_client, p_today)' IN v) = 0 THEN RAISE EXCEPTION 'create_order__inner changed shape'; END IF;
  EXECUTE replace(v, '_price_in_force(p_type, p_client, p_today)', '_price_in_force(p_type, p_client, p_today, public._order_plant())');
END $$;
--> statement-breakpoint
-- The reference prices (§16.1 door) per plant: one sell row per active plant (its own price, else the all-plants price).
DROP FUNCTION public.reference_prices(date);
--> statement-breakpoint
CREATE FUNCTION public.reference_prices(p_today date)
RETURNS TABLE(kind text, item_code text, item_name text, price_centimes bigint, plant_id uuid, plant_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN
     ('owner', 'app_admin', 'office', 'office_sales', 'office_purchases', 'plant', 'plant_manager', 'support') THEN
    RAISE EXCEPTION 'reference_prices: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT 'sell'::text, t.code, t.label, f.price_ht_per_m3_centimes, p.id, p.name
    FROM public.concrete_type t
    CROSS JOIN public.plant p
    CROSS JOIN LATERAL public._price_in_force(t.id, NULL, p_today, p.id) f
   WHERE p.status = 'active'
     AND (ctx.plant_scope() IS NULL OR p.id = ctx.plant_scope())
  UNION ALL
  SELECT 'buy'::text, c.code, c.name_fr,
         (SELECT avg(x.price_ht_centimes)::bigint FROM (
            SELECT DISTINCT ON (pp.supplier_id) pp.price_ht_centimes FROM public.purchase_price pp
             WHERE pp.component_id = c.id AND pp.effective_from <= p_today
             ORDER BY pp.supplier_id, pp.effective_from DESC) x),
         NULL::uuid, NULL::text
    FROM public.component c
   WHERE EXISTS (SELECT 1 FROM public.purchase_price pp WHERE pp.component_id = c.id AND pp.effective_from <= p_today)
  ORDER BY 1, 2, 6;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.reference_prices(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reference_prices(date) TO belgobeton_app;
