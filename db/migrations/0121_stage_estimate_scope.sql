-- R14-05: trip_stage_estimate (SECURITY DEFINER) authorizes positively and enforces scope itself.
-- 0118 refused with `ctx.driver_id() IS NULL AND v_role NOT IN (...)`, which is NULL, not true, when no role is set: a call with no role context
-- fell through and read history and overrides of ANY plant and zone. It also took the plant and zone from the caller without checking them.
-- Now: the caller must be (a) a driver, for a plant and zone of a rotation he is planned on (cancelled ones do not count), (b) a plant manager,
-- for his own plant, or (c) the owner or app_admin. Anything else, including no role at all, is refused.
-- A driver gets a median only when at least 3 DIFFERENT drivers' rotations are behind it (the median of one or two people is their own
-- timing); below that he gets the manager's override or the code's defaults. The manager and the owner have no such floor.
CREATE OR REPLACE FUNCTION public.trip_stage_estimate(p_plant uuid, p_zone uuid, p_stage text) RETURNS TABLE(minutes integer, source text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer; v_drivers integer; v_med integer;
  v_role text := ctx.actor_role();
  v_driver uuid := ctx.driver_id();
  v_allowed boolean := false;
BEGIN
  IF v_driver IS NOT NULL THEN
    v_allowed := EXISTS (
      SELECT 1 FROM public.trip_plan tp JOIN public.sales_order so ON so.id = tp.order_id
       WHERE tp.driver_id = v_driver AND tp.plant_id IS NOT DISTINCT FROM p_plant AND so.zone_id IS NOT DISTINCT FROM p_zone
         AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = tp.id));
  ELSIF v_role IN ('owner', 'app_admin') THEN
    v_allowed := true;
  ELSIF v_role = 'plant_manager' THEN
    v_allowed := p_plant IS NOT NULL AND p_plant = ctx.plant_scope();
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'trip_stage_estimate: role % may not read the estimate of this plant and route', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_stage IS NULL OR p_stage NOT IN ('loading', 'to_site', 'waiting', 'unloading', 'return', 'turnaround') THEN
    RAISE EXCEPTION 'trip_stage_estimate: unknown stage' USING ERRCODE = 'check_violation';
  END IF;
  IF p_stage <> 'turnaround' THEN
    SELECT count(*), count(DISTINCT q.driver_id), round(percentile_disc(0.5) WITHIN GROUP (ORDER BY q.dur))::integer INTO v_n, v_drivers, v_med FROM (
      SELECT h.dur, h.driver_id FROM (
        SELECT CASE p_stage
                 WHEN 'loading' THEN extract(epoch FROM (t.t_dep - t.t_load)) / 60
                 WHEN 'to_site' THEN extract(epoch FROM (t.t_arr - t.t_dep)) / 60
                 WHEN 'waiting' THEN extract(epoch FROM (t.t_us - t.t_arr)) / 60
                 WHEN 'unloading' THEN extract(epoch FROM (t.t_uf - t.t_us)) / 60
                 ELSE extract(epoch FROM (t.t_back - t.t_uf)) / 60 END AS dur,
               t.t_back, t.driver_id
          FROM (
            SELECT p.id, p.driver_id,
                   min(e.at) FILTER (WHERE e.step = 'departed') AS t_dep, min(e.at) FILTER (WHERE e.step = 'arrived') AS t_arr,
                   min(e.at) FILTER (WHERE e.step = 'unloading_started') AS t_us, min(e.at) FILTER (WHERE e.step = 'unloading_finished') AS t_uf,
                   min(e.at) FILTER (WHERE e.step = 'back') AS t_back,
                   (SELECT r.at FROM public.trip_driver_report r WHERE r.trip_id = p.id AND r.kind = 'loading_started') AS t_load
              FROM public.trip_plan p
              JOIN public.sales_order o ON o.id = p.order_id
              JOIN public.trip_event e ON e.trip_id = p.id
             WHERE p.plant_id IS NOT DISTINCT FROM p_plant AND o.zone_id IS NOT DISTINCT FROM p_zone
             GROUP BY p.id HAVING bool_or(e.step = 'back')) t) h
       WHERE h.dur IS NOT NULL AND h.dur >= 0 AND h.dur <= 720
       ORDER BY h.t_back DESC LIMIT 10) q;
    IF v_n >= 5 AND (v_driver IS NULL OR v_drivers >= 3) THEN
      RETURN QUERY SELECT v_med, 'history'::text;
      RETURN;
    END IF;
  END IF;
  RETURN QUERY
  SELECT o.minutes, 'override'::text FROM public.trip_estimate_override o
   WHERE o.plant_id = p_plant AND o.stage = p_stage AND (o.zone_id IS NOT DISTINCT FROM p_zone OR o.zone_id IS NULL)
   ORDER BY (o.zone_id IS NOT NULL) DESC, o.created_at DESC LIMIT 1;
END $$;
