-- C4.3 (REQUIREMENTS-V1 §16.9): the day close gains the fuel variance line. Litres only, no price. Cash per holder is money and is
-- read by the owner and app_admin from the finance module on the same page (not by this function).
CREATE OR REPLACE FUNCTION public.day_close_status(p_plant uuid, p_date date)
  RETURNS TABLE(kind text, n integer, refs text[], blocking boolean) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support', 'partner', 'plant', 'plant_manager') THEN
    RAISE EXCEPTION 'day_close: role % may not read it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ctx.actor_role() = 'plant_manager' AND p_plant IS DISTINCT FROM ctx.plant_scope() THEN
    RAISE EXCEPTION 'day_close: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT 'unconfirmed_load'::text, count(*)::integer, coalesce((array_agg(d.bl_no ORDER BY d.bl_no))[1:5], '{}'), true
    FROM public.delivery d
   WHERE d.plant_id = p_plant AND d.load_date = p_date AND d.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_delivered x WHERE x.delivery_id = d.id);
  RETURN QUERY SELECT 'missing_bl'::text, count(*)::integer, coalesce((array_agg(d.bl_no ORDER BY d.bl_no))[1:5], '{}'), false
    FROM public.delivery d
   WHERE d.plant_id = p_plant AND d.load_date = p_date AND d.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_return x WHERE x.delivery_id = d.id);
  RETURN QUERY SELECT 'stock_variance'::text, count(DISTINCT m.source_id)::integer, '{}'::text[], true
    FROM public.stock_movement m WHERE m.plant_id = p_plant AND m.movement_date = p_date AND m.source = 'count_adjustment';
  -- C4.3 fuel variance (REQUIREMENTS-V1 §16.9). (a) fuel transfers received on the day where the litres received differ from the litres
  -- sent (either side of the transfer): information, the owner was already told when it was received. (b) a tank whose computed level
  -- is below zero once its opening level has been set (before that the figure is not tracked): more fuel was dispensed than the records say entered it, which cannot be true, so it blocks the close.
  RETURN QUERY SELECT 'fuel_transfer_variance'::text, count(*)::integer, coalesce((array_agg(left(t.id::text, 8) ORDER BY t.created_at))[1:5], '{}'), false
    FROM public.plant_transfer t
    JOIN public.plant_transfer_step s ON s.transfer_id = t.id AND s.step = 'received'
   WHERE t.kind = 'fuel' AND t.status = 'received' AND t.received_qty <> t.qty AND s.at::date = p_date
     AND (t.from_plant = p_plant OR t.to_plant = p_plant);
  RETURN QUERY SELECT 'fuel_tank_negative'::text, count(*)::integer, '{}'::text[], true
    FROM public.fuel_tank_levels() f WHERE f.plant_id = p_plant AND f.as_of IS NOT NULL AND f.level_ml < 0;
END $$;
