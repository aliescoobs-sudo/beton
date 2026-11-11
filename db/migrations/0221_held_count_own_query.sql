-- R18-08: the held-delivery COUNT (office roles, a number only) executed the whole detail query (0214 cloned trip_delivery_exceptions and filtered the result), so its
-- cost and its errors depended on hidden volume sums and per-order scans, and a caller could vary the date range freely. It is now its OWN query over exactly what the
-- two held predicates need: the plans, their unloading and loading stage rows, the cancellations and the billing marker. No order, truck, load, volume or sum is read.
--   declared_no_record : the driver explicitly declared the end of the unloading and the plant has recorded no load for the rotation;
--   unconfirmed        : the unloading was declared explicitly, a load is recorded, no billing marker exists and the day's confirmation time has passed.
-- The range is bounded: from <= to, at most 62 days (the queue page asks for 15). The internal detail reader (0214) stays, not executable by the application login.
-- Forward migration.
CREATE OR REPLACE FUNCTION public.trip_delivery_held_count(p_from date, p_to date) RETURNS integer
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text := ctx.actor_role();
  v_all   boolean;
  v_start integer;
  v_work  integer;
  v_delay integer;
  v_n     integer;
BEGIN
  IF ctx.driver_id() IS NOT NULL OR v_role IS NULL
     OR coalesce(v_role, '') NOT IN ('owner', 'app_admin', 'plant', 'plant_manager', 'office_sales', 'office') THEN
    RAISE EXCEPTION 'trip_delivery_held_count: role % may not read it', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 62 THEN
    RAISE EXCEPTION 'trip_delivery_held_count: the range is at most 62 days, from before to' USING ERRCODE = 'check_violation';
  END IF;
  -- the office roles count every plant (and a rotation with no plant: the office dispatch roles see those, decision 207); the plant side is scoped as for the details
  v_all := v_role IN ('office_sales', 'office');
  v_start := coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'day_start_min'), 420);
  v_work  := coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'working_min'), 600);
  v_delay := coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'delivery_confirm_delay_min'), 0);
  SELECT count(*)::integer INTO v_n
    FROM public.trip_plan p
    JOIN public.trip_event fin ON fin.trip_id = p.id AND fin.step = 'unloading_finished' AND NOT fin.implicit
    LEFT JOIN public.trip_event l ON l.trip_id = p.id AND l.step = 'loaded'
   WHERE p.trip_date BETWEEN p_from AND p_to
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
     AND (v_all OR v_role IN ('owner', 'app_admin', 'plant')
          OR (v_role = 'plant_manager' AND p.plant_id IS NOT NULL AND p.plant_id = ctx.plant_scope()))
     AND ((fin.source = 'driver' AND l.delivery_id IS NULL)
          OR (l.delivery_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.delivery_delivered g WHERE g.delivery_id = l.delivery_id)
              AND now() > ((p.trip_date::timestamp + make_interval(mins => v_start + v_work + v_delay)) AT TIME ZONE 'Africa/Casablanca')));
  RETURN v_n;
END $$;
