-- T5 phase 2: stage timing of the rotations. Each driver tap is compared with the plan and the delay is recorded (append-only);
-- estimates per plant, zone and stage come from the history of completed rotations, else an audited override, else code defaults;
-- the plant manager's reassignments and postponements are recorded with their reason.
-- PRIVACY: delay data is performance data about named drivers. Only that driver (own), his plant manager (own plant) and the owner or
-- app_admin read it; accountant, sales, purchases, partner and support never do. Enforced by row-level security and by the doors below.

CREATE FUNCTION public._forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint

-- 1. The delay of each driver tap.
CREATE TABLE public.trip_delay (
  id                   uuid PRIMARY KEY,
  trip_id              uuid NOT NULL REFERENCES public.trip_plan (id),
  driver_id            uuid NOT NULL REFERENCES public.driver (id),
  plant_id             uuid REFERENCES public.plant (id),
  -- The day and the route of the rotation, kept here so that the statistics need nothing else (a driver cannot read the plan or the orders).
  trip_date            date NOT NULL,
  zone_id              uuid REFERENCES public.zone (id),
  step                 text NOT NULL CHECK (step IN ('loading_started', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back')),
  planned_at           timestamptz NOT NULL,
  -- The phone's own time of the tap (bounded by the door) and the server's time of receipt.
  tapped_at            timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  -- This stage against its planned length (null when the stage before was not tapped), and this tap against its planned time.
  stage_delay_min      integer,
  cumulative_delay_min integer NOT NULL,
  reason               text CHECK (reason IN ('traffic', 'site_wait', 'breakdown', 'other')),
  created_by           uuid NOT NULL,
  UNIQUE (trip_id, step)
);
--> statement-breakpoint
CREATE INDEX trip_delay_plant_idx ON public.trip_delay (plant_id, trip_date);
--> statement-breakpoint
CREATE INDEX trip_delay_driver_idx ON public.trip_delay (driver_id, trip_date);
--> statement-breakpoint
CREATE TRIGGER trip_delay_append_only BEFORE UPDATE OR DELETE ON public.trip_delay FOR EACH ROW EXECUTE FUNCTION public._forbid_change();
--> statement-breakpoint

-- 2. Overrides of an estimate: insert-only, the latest row of a (plant, zone, stage) wins; a null zone is every zone of the plant.
CREATE TABLE public.trip_estimate_override (
  id         uuid PRIMARY KEY,
  plant_id   uuid NOT NULL REFERENCES public.plant (id),
  zone_id    uuid REFERENCES public.zone (id),
  stage      text NOT NULL CHECK (stage IN ('loading', 'to_site', 'waiting', 'unloading', 'return', 'turnaround')),
  minutes    integer NOT NULL CHECK (minutes BETWEEN 0 AND 720),
  reason     text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER trip_estimate_override_append_only BEFORE UPDATE OR DELETE ON public.trip_estimate_override FOR EACH ROW EXECUTE FUNCTION public._forbid_change();
--> statement-breakpoint

-- 3. What the plant manager did about a rotation that would run late.
CREATE TABLE public.trip_dispatch_change (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('reassign', 'postpone')),
  old_trip_id uuid NOT NULL REFERENCES public.trip_plan (id),
  new_trip_id uuid REFERENCES public.trip_plan (id),
  plant_id    uuid REFERENCES public.plant (id),
  from_truck  uuid REFERENCES public.truck (id),
  to_truck    uuid REFERENCES public.truck (id),
  from_driver uuid REFERENCES public.driver (id),
  to_driver   uuid REFERENCES public.driver (id),
  reason      text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER trip_dispatch_change_append_only BEFORE UPDATE OR DELETE ON public.trip_dispatch_change FOR EACH ROW EXECUTE FUNCTION public._forbid_change();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_delay', 'trip_estimate_override', 'trip_dispatch_change'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('SELECT audit.attach(''public.%I'')', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Who reads the delays: the driver's own, the plant manager's own plant, the owner and app_admin. Nobody else, support included.
CREATE POLICY trip_delay_read ON public.trip_delay FOR SELECT TO belgobeton_app USING (
  ctx.actor_role() IN ('owner', 'app_admin')
  OR (ctx.actor_role() = 'plant_manager' AND plant_id IS NOT NULL AND plant_id = ctx.plant_scope())
  OR (driver_id = ctx.driver_id()));
--> statement-breakpoint
CREATE POLICY trip_estimate_override_read ON public.trip_estimate_override FOR SELECT TO belgobeton_app USING (
  ctx.actor_role() IN ('owner', 'app_admin') OR (ctx.actor_role() = 'plant_manager' AND plant_id = ctx.plant_scope()));
--> statement-breakpoint
CREATE POLICY trip_dispatch_change_read ON public.trip_dispatch_change FOR SELECT TO belgobeton_app USING (
  ctx.actor_role() IN ('owner', 'app_admin') OR (ctx.actor_role() = 'plant_manager' AND plant_id IS NOT NULL AND plant_id = ctx.plant_scope()));
--> statement-breakpoint

-- The audit trail must not be a side door to the same data: the audit rows of the delays and of the changes made because of them (they name
-- drivers) are read by the owner and app_admin only, whatever the other audit policies allow (partner, office, plant managers, support).
CREATE POLICY audit_event_trip_performance ON public.audit_event AS RESTRICTIVE FOR SELECT TO belgobeton_app
  USING (table_name NOT IN ('trip_delay', 'trip_dispatch_change') OR ctx.actor_role() IN ('owner', 'app_admin'));
--> statement-breakpoint

-- The planned instant of a plan minute: the trip's day at midnight Casablanca plus the minutes (they may pass 1440).
CREATE FUNCTION public._plan_time(p_date date, p_min integer) RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_date::timestamp + make_interval(mins => p_min)) AT TIME ZONE 'Africa/Casablanca'
$$;
--> statement-breakpoint

-- Records the delay of one driver tap. Called only by driver_report. A stage tapped before the previous one leaves its stage delay empty.
CREATE FUNCTION public._record_trip_delay(p_trip uuid, p_driver uuid, p_step text, p_at timestamptz, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_p public.trip_plan%ROWTYPE;
  v_order text[] := ARRAY['loading_started', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'];
  v_planned timestamptz;
  v_prev record;
  v_stage integer;
BEGIN
  SELECT * INTO v_p FROM public.trip_plan WHERE id = p_trip;
  -- Unloading starts, in the plan, when the truck arrives: any waiting on site shows as delay of that stage.
  v_planned := public._plan_time(v_p.trip_date, CASE p_step
    WHEN 'loading_started' THEN v_p.load_min WHEN 'departed' THEN v_p.depart_min WHEN 'arrived' THEN v_p.arrive_min
    WHEN 'unloading_started' THEN v_p.arrive_min WHEN 'unloading_finished' THEN v_p.unload_end_min ELSE v_p.back_min END);
  SELECT d.planned_at, d.tapped_at INTO v_prev FROM public.trip_delay d
   WHERE d.trip_id = p_trip AND array_position(v_order, d.step) < array_position(v_order, p_step)
   ORDER BY array_position(v_order, d.step) DESC LIMIT 1;
  IF FOUND THEN
    v_stage := round(extract(epoch FROM ((p_at - v_prev.tapped_at) - (v_planned - v_prev.planned_at))) / 60);
  END IF;
  INSERT INTO public.trip_delay (id, trip_id, driver_id, plant_id, trip_date, zone_id, step, planned_at, tapped_at, stage_delay_min, cumulative_delay_min, reason, created_by)
  VALUES (gen_random_uuid(), p_trip, p_driver, v_p.plant_id, v_p.trip_date, (SELECT o.zone_id FROM public.sales_order o WHERE o.id = v_p.order_id), p_step, v_planned, p_at, v_stage,
          round(extract(epoch FROM (p_at - v_planned)) / 60), nullif(p_reason, ''), ctx.user_id())
  ON CONFLICT (trip_id, step) DO NOTHING;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._record_trip_delay(uuid, uuid, text, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._plan_time(date, integer) FROM PUBLIC;
--> statement-breakpoint

-- The tap itself: as before (migration 0084), and it now records its delay and an optional reason. The five-argument form goes; a call with
-- five arguments still works through the default.
DROP FUNCTION public.driver_report(uuid, text, timestamptz, text, integer);
--> statement-breakpoint
CREATE FUNCTION public.driver_report(p_trip uuid, p_step text, p_at timestamptz, p_key text, p_volume_l integer, p_reason text DEFAULT NULL) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_report: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = p_trip AND p.driver_id = v_driver) THEN
    RAISE EXCEPTION 'driver_report: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_at > now() + interval '5 minutes' OR p_at < now() - interval '48 hours' THEN
    RAISE EXCEPTION 'driver_report: the time of the tap is not credible' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NOT NULL AND p_reason NOT IN ('traffic', 'site_wait', 'breakdown', 'other', '') THEN
    RAISE EXCEPTION 'driver_report: unknown delay reason' USING ERRCODE = 'check_violation';
  END IF;
  -- a replay of a tap already stored (same key) changes nothing
  IF EXISTS (SELECT 1 FROM public.trip_driver_report r WHERE r.driver_id = v_driver AND r.client_key = p_key)
     OR EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = p_step AND e.created_by = ctx.user_id()) THEN
    RETURN 'replayed';
  END IF;
  IF p_step = 'loading_started' THEN
    INSERT INTO public.trip_driver_report (id, trip_id, driver_id, kind, at, client_key)
    VALUES (gen_random_uuid(), p_trip, v_driver, 'loading_started', p_at, p_key)
    ON CONFLICT (trip_id, kind) DO NOTHING;
    PERFORM public._record_trip_delay(p_trip, v_driver, p_step, p_at, p_reason);
    RETURN 'recorded';
  ELSIF p_step IN ('departed', 'arrived', 'unloading_started', 'unloading_finished', 'back') THEN
    IF p_step = 'unloading_finished' THEN
      IF p_volume_l IS NULL THEN
        RAISE EXCEPTION 'driver_report: the m3 unloaded is required' USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO public.trip_driver_report (id, trip_id, driver_id, kind, at, volume_l, client_key)
      VALUES (gen_random_uuid(), p_trip, v_driver, 'unloaded', p_at, p_volume_l, p_key);
    END IF;
    INSERT INTO public.trip_event (id, trip_id, step, at, created_by) VALUES (gen_random_uuid(), p_trip, p_step, p_at, ctx.user_id());
    PERFORM public._record_trip_delay(p_trip, v_driver, p_step, p_at, p_reason);
    RETURN 'recorded';
  END IF;
  RAISE EXCEPTION 'driver_report: unknown step' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.driver_report(uuid, text, timestamptz, text, integer, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.driver_report(uuid, text, timestamptz, text, integer, text) TO belgobeton_app;
--> statement-breakpoint

-- The timing inputs of a day, for the rotations the caller may see: a driver his own, a plant manager his plant's, owner and app_admin all.
CREATE FUNCTION public.trip_timing(p_date date) RETURNS TABLE(
  trip_id uuid, seq integer, order_code text, plant_id uuid, truck_id uuid, truck_code text, driver_id uuid, driver_name text,
  zone_id uuid, zone_name text, one_way_min integer, load_min integer, depart_min integer, arrive_min integer,
  unload_end_min integer, back_min integer, steps json)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id(); v_role text := ctx.actor_role();
BEGIN
  IF v_driver IS NULL AND v_role IS DISTINCT FROM 'plant_manager' AND v_role NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'trip_timing: role % may not read the timing of rotations', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT p.id, p.seq, o.code, p.plant_id, p.truck_id, k.code, p.driver_id, d.name, o.zone_id, z.name, z.one_way_min,
         p.load_min, p.depart_min, p.arrive_min, p.unload_end_min, p.back_min,
         coalesce((SELECT json_agg(json_build_object('step', s.step, 'at', s.at) ORDER BY s.at) FROM (
            SELECT e.step, e.at FROM public.trip_event e WHERE e.trip_id = p.id
            UNION ALL SELECT r.kind, r.at FROM public.trip_driver_report r WHERE r.trip_id = p.id AND r.kind = 'loading_started') s), '[]'::json)
    FROM public.trip_plan p
    JOIN public.sales_order o ON o.id = p.order_id
    JOIN public.truck k ON k.id = p.truck_id
    LEFT JOIN public.driver d ON d.id = p.driver_id
    LEFT JOIN public.zone z ON z.id = o.zone_id
   WHERE p.trip_date = p_date
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
     AND ((v_driver IS NOT NULL AND p.driver_id = v_driver)
          OR v_role IN ('owner', 'app_admin')
          OR (v_role = 'plant_manager' AND p.plant_id IS NOT NULL AND p.plant_id = ctx.plant_scope()))
   ORDER BY p.truck_id, p.load_min, p.seq;
END $$;
--> statement-breakpoint

-- The estimate of one stage for a plant and a zone (null zone: an order without one): the MEDIAN of the last 10 completed rotations of that
-- key when there are at least 5, else the latest override, else nothing (the code's defaults apply). Whole minutes.
CREATE FUNCTION public.trip_stage_estimate(p_plant uuid, p_zone uuid, p_stage text) RETURNS TABLE(minutes integer, source text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer; v_med integer; v_role text := ctx.actor_role();
BEGIN
  IF ctx.driver_id() IS NULL AND v_role NOT IN ('owner', 'app_admin', 'plant_manager') THEN
    RAISE EXCEPTION 'trip_stage_estimate: role % may not read estimates', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_stage NOT IN ('loading', 'to_site', 'waiting', 'unloading', 'return', 'turnaround') THEN
    RAISE EXCEPTION 'trip_stage_estimate: unknown stage' USING ERRCODE = 'check_violation';
  END IF;
  IF p_stage <> 'turnaround' THEN
    SELECT count(*), round(percentile_disc(0.5) WITHIN GROUP (ORDER BY q.dur))::integer INTO v_n, v_med FROM (
      SELECT h.dur FROM (
        SELECT CASE p_stage
                 WHEN 'loading' THEN extract(epoch FROM (t.t_dep - t.t_load)) / 60
                 WHEN 'to_site' THEN extract(epoch FROM (t.t_arr - t.t_dep)) / 60
                 WHEN 'waiting' THEN extract(epoch FROM (t.t_us - t.t_arr)) / 60
                 WHEN 'unloading' THEN extract(epoch FROM (t.t_uf - t.t_us)) / 60
                 ELSE extract(epoch FROM (t.t_back - t.t_uf)) / 60 END AS dur,
               t.t_back
          FROM (
            SELECT p.id,
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
    IF v_n >= 5 THEN
      RETURN QUERY SELECT v_med, 'history'::text;
      RETURN;
    END IF;
  END IF;
  RETURN QUERY
  SELECT o.minutes, 'override'::text FROM public.trip_estimate_override o
   WHERE o.plant_id = p_plant AND o.stage = p_stage AND (o.zone_id IS NOT DISTINCT FROM p_zone OR o.zone_id IS NULL)
   ORDER BY (o.zone_id IS NOT NULL) DESC, o.created_at DESC LIMIT 1;
END $$;
--> statement-breakpoint

-- A plant manager (own plant), the owner or app_admin overrides the default estimate of a stage for a route. Audited by the table's trigger.
CREATE FUNCTION public.set_trip_estimate(p_plant uuid, p_zone uuid, p_stage text, p_minutes integer, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role(); v_id uuid := gen_random_uuid();
BEGIN
  IF v_role NOT IN ('owner', 'app_admin', 'plant_manager') THEN
    RAISE EXCEPTION 'set_trip_estimate: role % may not change estimates', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role = 'plant_manager' AND p_plant IS DISTINCT FROM ctx.plant_scope() THEN
    RAISE EXCEPTION 'set_trip_estimate: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.trip_estimate_override (id, plant_id, zone_id, stage, minutes, reason, created_by)
  VALUES (v_id, p_plant, p_zone, p_stage, p_minutes, btrim(coalesce(p_reason, '')), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint

-- The record of a reassignment or a postponement (the plan change itself is made by the dispatch service in the same transaction).
CREATE FUNCTION public.log_dispatch_change(p_kind text, p_old uuid, p_new uuid, p_from_truck uuid, p_to_truck uuid, p_from_driver uuid, p_to_driver uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role(); v_plant uuid; v_id uuid := gen_random_uuid();
BEGIN
  IF v_role NOT IN ('owner', 'app_admin', 'plant_manager') THEN
    RAISE EXCEPTION 'log_dispatch_change: role % may not', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT plant_id INTO v_plant FROM public.trip_plan WHERE id = p_old;
  IF v_role = 'plant_manager' AND v_plant IS DISTINCT FROM ctx.plant_scope() THEN
    RAISE EXCEPTION 'log_dispatch_change: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.trip_dispatch_change (id, kind, old_trip_id, new_trip_id, plant_id, from_truck, to_truck, from_driver, to_driver, reason, created_by)
  VALUES (v_id, p_kind, p_old, p_new, v_plant, p_from_truck, p_to_truck, p_from_driver, p_to_driver, btrim(coalesce(p_reason, '')), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint

-- The four plan parameters the default estimates come from, for the roles that read the timing (the driver cannot read the parameter table).
CREATE FUNCTION public.timing_parameter(p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.driver_id() IS NULL AND ctx.actor_role() IS DISTINCT FROM 'plant_manager' AND ctx.actor_role() NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'timing_parameter: role % may not read parameters', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key NOT IN ('loading_min', 'unloading_min', 'return_extra_min', 'default_one_way_min') THEN
    RAISE EXCEPTION 'timing_parameter: % is not a timing parameter', p_key USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT p.value FROM public.parameter p WHERE p.key = p_key);
END $$;
--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'timing_parameter(text)', 'trip_timing(date)', 'trip_stage_estimate(uuid, uuid, text)', 'set_trip_estimate(uuid, uuid, text, integer, text)',
    'log_dispatch_change(text, uuid, uuid, uuid, uuid, uuid, uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
END $$;
