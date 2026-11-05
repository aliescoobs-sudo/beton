-- R11-05 of the training review: F01 still failed open for NULL plant values.
-- (1) `_pump_in_scope(NULL)` returned NULL for a manager (false OR NULL), and `IF NOT NULL THEN RAISE` never raises: legacy or unassigned
--     rows passed the mutation doors. It now returns a definite boolean: anything other than true is a denial.
-- (2) `redirect_candidates` filtered the CASE by scope but not the candidate ROWS: a manager got other plants' (case with a NULL plant)
--     or unassigned orders and their site labels. Each candidate row is now checked with `_pump_in_scope(o.plant_id)`.
CREATE OR REPLACE FUNCTION public._pump_in_scope(p_plant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(ctx.plant_scope() IS NULL OR p_plant = ctx.plant_scope(), false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.redirect_candidates(p_case uuid, p_now timestamptz)
  RETURNS TABLE(order_id uuid, order_code text, type_code text, remaining_l integer, site_label text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_c public.cancellation_case%ROWTYPE;
  v_type text;
  v_mixed timestamptz;
  v_limit integer;
BEGIN
  PERFORM public.cancellation_actor_check(false, NULL);
  SELECT * INTO v_c FROM public.cancellation_case WHERE id = p_case;
  IF NOT FOUND OR v_c.case_no NOT IN (3, 4, 5, 7) THEN RETURN; END IF;
  IF NOT public._pump_in_scope(v_c.plant_id) THEN
    RAISE EXCEPTION 'redirect_candidates: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.code INTO v_type FROM public.sales_order o JOIN public.concrete_type t ON t.id = o.concrete_type_id WHERE o.id = v_c.order_id;
  SELECT coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'concrete_limit_min'), 120) INTO v_limit;
  SELECT e.at INTO v_mixed FROM public.trip_event e WHERE e.trip_id = v_c.trip_id AND e.step = 'loaded';
  IF v_mixed IS NOT NULL AND p_now > v_mixed + make_interval(mins => v_limit) THEN RETURN; END IF;
  RETURN QUERY
    SELECT o.id, o.code, t.code,
           (o.volume_l - coalesce((SELECT sum(d.volume_l) FROM public.delivery d WHERE d.order_id = o.id), 0))::integer,
           s.label
      FROM public.sales_order o
      JOIN public.concrete_type t ON t.id = o.concrete_type_id
      LEFT JOIN public.client_site s ON s.id = o.site_id
     WHERE o.reverses_id IS NULL AND o.id <> v_c.order_id
       AND o.delivery_date = p_now::date
       AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
       AND (t.code = v_type OR (public.concrete_strength(t.code) IS NOT NULL AND public.concrete_strength(v_type) IS NOT NULL
                                AND public.concrete_strength(t.code) <= public.concrete_strength(v_type)))
       AND o.volume_l - coalesce((SELECT sum(d.volume_l) FROM public.delivery d WHERE d.order_id = o.id), 0) >= coalesce(v_c.surplus_volume_l, 1)
       AND (v_c.plant_id IS NULL OR o.plant_id IS NULL OR o.plant_id = v_c.plant_id)
       -- R11-05: the rows themselves are filtered by the caller's scope; a manager never sees an unassigned (NULL plant) order
       AND public._pump_in_scope(o.plant_id)
     ORDER BY o.code;
END $$;
