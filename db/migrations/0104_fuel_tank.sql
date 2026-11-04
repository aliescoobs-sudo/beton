-- C3 (REQUIREMENTS-V1 §16.5, second bullet "fuel stock effect of a fuel transfer"): the fuel tank of each plant has a level. It is
-- never stored as a figure: it is computed from the opening level, the fuel bought for the plant, the fuel received from the other
-- plant, the fuel dispensed from the tank, and the fuel sent to the other plant. A transfer takes the litres out of the sending tank
-- when it is sent and puts the litres RECEIVED into the receiving tank; the difference stays visible as the transfer variance.
-- Litres only, no price: the purchase total never leaves fuel_purchase (owner and support).
CREATE TABLE public.fuel_tank_opening (
  plant_id uuid PRIMARY KEY REFERENCES public.plant (id),
  level_ml bigint NOT NULL CHECK (level_ml >= 0),
  -- Movements before this date are inside the opening level; from this date on they count.
  as_of    date NOT NULL,
  set_by   uuid NOT NULL,
  set_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.fuel_tank_opening ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.fuel_tank_opening FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.fuel_tank_opening FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.fuel_tank_opening TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY fuel_tank_opening_read ON public.fuel_tank_opening FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant') AND (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
SELECT public.grant_support_read('public.fuel_tank_opening');
--> statement-breakpoint
CREATE POLICY fuel_tank_opening_definer ON public.fuel_tank_opening FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
SELECT audit.attach('public.fuel_tank_opening');
--> statement-breakpoint

-- The level function reads the litres of the purchases as the definer, only for the roles that may read the tank (never the total paid).
CREATE POLICY fuel_purchase_tank_definer_read ON public.fuel_purchase FOR SELECT TO belgobeton_migrator
  USING (ctx.role() IN ('owner', 'partner', 'plant', 'support'));
--> statement-breakpoint
-- The level on the day the plant starts using the tank figure: once per plant (a later correction is a count, not a rewrite).
CREATE FUNCTION public.set_fuel_tank_opening(p_plant uuid, p_litres bigint, p_as_of date) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.transfer_actor_ok(p_plant) THEN
    RAISE EXCEPTION 'fuel tank: only the plant manager of this plant, the owner or app_admin sets the opening level' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_litres IS NULL OR p_litres < 0 OR p_litres > 1000000 OR p_as_of IS NULL THEN
    RAISE EXCEPTION 'fuel tank: invalid opening level' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.plant WHERE id = p_plant AND status = 'active') THEN
    RAISE EXCEPTION 'fuel tank: unknown or archived plant' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.fuel_tank_opening (plant_id, level_ml, as_of, set_by) VALUES (p_plant, p_litres * 1000, p_as_of, ctx.user_id());
  RETURN true;
END $$;
--> statement-breakpoint

-- The level of every tank the caller may see, with the five parts it is made of (millilitres). Computed on every call.
CREATE FUNCTION public.fuel_tank_levels() RETURNS TABLE(
  plant_id uuid, plant_name text, opening_ml bigint, as_of date, purchased_ml bigint, received_ml bigint, filled_ml bigint, sent_ml bigint,
  in_transit_ml bigint, level_ml bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'plant', 'support') THEN
    RAISE EXCEPTION 'fuel_tank_levels: role % may not read them', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT x.plant_id, x.plant_name, x.opening_ml, x.as_of, x.purchased_ml, x.received_ml, x.filled_ml, x.sent_ml, x.in_transit_ml,
           x.opening_ml + x.purchased_ml + x.received_ml - x.filled_ml - x.sent_ml
      FROM (
        SELECT p.id AS plant_id, p.name AS plant_name, coalesce(o.level_ml, 0)::bigint AS opening_ml, o.as_of,
               coalesce((SELECT sum(b.litres_ml) FROM public.fuel_purchase b WHERE b.plant_id = p.id AND (o.as_of IS NULL OR b.purchased_on >= o.as_of)), 0)::bigint AS purchased_ml,
               coalesce((SELECT sum(t.received_qty * 1000) FROM public.plant_transfer t
                           JOIN public.plant_transfer_step s ON s.transfer_id = t.id AND s.step = 'received'
                          WHERE t.kind = 'fuel' AND t.to_plant = p.id AND t.status = 'received' AND (o.as_of IS NULL OR s.at::date >= o.as_of)), 0)::bigint AS received_ml,
               coalesce((SELECT sum(f.litres_ml) FROM public.fuel_fill f WHERE f.plant_id = p.id AND f.source = 'tank' AND (o.as_of IS NULL OR f.filled_on >= o.as_of)), 0)::bigint AS filled_ml,
               coalesce((SELECT sum(t.qty * 1000) FROM public.plant_transfer t
                           JOIN public.plant_transfer_step s ON s.transfer_id = t.id AND s.step = 'sent'
                          WHERE t.kind = 'fuel' AND t.from_plant = p.id AND (o.as_of IS NULL OR s.at::date >= o.as_of)), 0)::bigint AS sent_ml,
               coalesce((SELECT sum(t.qty * 1000) FROM public.plant_transfer t WHERE t.kind = 'fuel' AND t.to_plant = p.id AND t.status <> 'received'), 0)::bigint AS in_transit_ml
          FROM public.plant p LEFT JOIN public.fuel_tank_opening o ON o.plant_id = p.id
         WHERE p.status = 'active' AND (ctx.plant_scope() IS NULL OR p.id = ctx.plant_scope())
      ) x
     ORDER BY x.plant_name;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.set_fuel_tank_opening(uuid, bigint, date) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.fuel_tank_levels() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_fuel_tank_opening(uuid, bigint, date) TO belgobeton_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.fuel_tank_levels() TO belgobeton_app;
