-- C3 (REQUIREMENTS-V1 §16.6, basic): pump coordination. An order can be marked "pumped". A pumped pour needs a pump scheduled on
-- site (a time, a set-up duration, a pumping duration) BEFORE any truck can be planned for it; a truck planned to arrive before the
-- pump is ready, and a pump booked twice over the same time, raise a conflict and an alert. Times are minutes since midnight, like
-- the trip plan. Quantities and times only, never a price.
CREATE TABLE public.order_pump (
  order_id   uuid PRIMARY KEY REFERENCES public.sales_order (id),
  pumped     boolean NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.pump_job
  ADD COLUMN order_id    uuid REFERENCES public.sales_order (id),
  ADD COLUMN on_site_min integer CHECK (on_site_min BETWEEN 0 AND 1439),
  ADD COLUMN setup_min   integer NOT NULL DEFAULT 30 CHECK (setup_min BETWEEN 0 AND 240),
  ADD COLUMN duration_min integer CHECK (duration_min BETWEEN 10 AND 960);
--> statement-breakpoint
CREATE INDEX pump_job_order_idx ON public.pump_job (order_id);
--> statement-breakpoint
CREATE TABLE public.pump_conflict (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('pump_double_booked', 'truck_before_pump')),
  job_date     date NOT NULL,
  order_id     uuid REFERENCES public.sales_order (id),
  job_id       uuid NOT NULL REFERENCES public.pump_job (id),
  other_job_id uuid REFERENCES public.pump_job (id),
  trip_id      uuid REFERENCES public.trip_plan (id),
  plant_id     uuid REFERENCES public.plant (id),
  detail       text CHECK (detail IS NULL OR length(detail) <= 300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid,
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);
--> statement-breakpoint
-- One OPEN conflict per pair or trip: once resolved (or the job moved), the same conflict can be raised again if it still holds.
CREATE UNIQUE INDEX pump_conflict_open_uidx ON public.pump_conflict (kind, job_id, other_job_id, trip_id) NULLS NOT DISTINCT WHERE resolved_at IS NULL;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_pump', 'pump_conflict'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() IN (''owner'', ''partner'', ''office'', ''plant''))', t || '_read', t);
    EXECUTE format('CREATE POLICY support_read ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''support'')', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('SELECT audit.attach(''public.%I'')', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- The trip plan is read by the definer functions below.
CREATE POLICY pump_trip_plan_definer_read ON public.trip_plan FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- Who may plan: the roles of the existing pump planning (create_pump_job) and the planning of trips.
CREATE FUNCTION public._pump_actor_check() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager') THEN
    RAISE EXCEPTION 'pump: role % may not plan a pump', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._pump_actor_check() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.set_order_pumped(p_order uuid, p_pumped boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._pump_actor_check();
  IF NOT EXISTS (SELECT 1 FROM public.sales_order o WHERE o.id = p_order AND o.reverses_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)) THEN
    RAISE EXCEPTION 'pump: not a live order' USING ERRCODE = 'check_violation';
  END IF;
  -- An order cannot lose its pump while a pump is scheduled for it: cancel or move that pump first.
  IF NOT p_pumped AND EXISTS (SELECT 1 FROM public.pump_job j WHERE j.order_id = p_order) THEN
    RAISE EXCEPTION 'pump: a pump is scheduled for this order' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.order_pump (order_id, pumped, updated_by) VALUES (p_order, p_pumped, ctx.user_id())
    ON CONFLICT (order_id) DO UPDATE SET pumped = EXCLUDED.pumped, updated_by = EXCLUDED.updated_by, updated_at = now();
  RETURN true;
END $$;
--> statement-breakpoint

-- The two checks of a pump job against the day: another job of the same pump overlapping, and the trucks of the order planned to
-- arrive before the pump is ready. Idempotent (a conflict is recorded once per pair or trip).
CREATE FUNCTION public._pump_check_job(p_job uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  j public.pump_job%ROWTYPE;
  o record;
  t record;
  v_n integer := 0;
  v_end integer;
  v_id uuid;
BEGIN
  SELECT * INTO j FROM public.pump_job WHERE id = p_job;
  IF NOT FOUND OR j.on_site_min IS NULL THEN RETURN 0; END IF;
  v_end := j.on_site_min + j.setup_min + coalesce(j.duration_min, 120);
  FOR o IN SELECT x.id, x.on_site_min, x.setup_min + coalesce(x.duration_min, 120) AS span
             FROM public.pump_job x
            WHERE x.pump_id = j.pump_id AND x.job_date = j.job_date AND x.id <> j.id AND x.on_site_min IS NOT NULL
              AND x.on_site_min < v_end AND j.on_site_min < x.on_site_min + x.setup_min + coalesce(x.duration_min, 120) LOOP
    v_id := gen_random_uuid();
    INSERT INTO public.pump_conflict (id, kind, job_date, order_id, job_id, other_job_id, detail)
    VALUES (v_id, 'pump_double_booked', j.job_date, j.order_id, GREATEST(j.id, o.id), LEAST(j.id, o.id), 'the pump is booked twice over the same time')
    ON CONFLICT DO NOTHING;
    IF FOUND THEN
      v_n := v_n + 1;
      PERFORM public.notify('day_conflict', 'important', jsonb_build_object('kind', 'pump_double_booked'), '/pumps', NULL,
                            ARRAY['owner', 'app_admin', 'plant_manager', 'office_sales'], NULL);
    END IF;
  END LOOP;
  IF j.order_id IS NOT NULL THEN
    FOR t IN SELECT p.id, p.plant_id FROM public.trip_plan p
              WHERE p.order_id = j.order_id AND p.trip_date = j.job_date
                AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = p.id)
                AND p.arrive_min < j.on_site_min + j.setup_min LOOP
      INSERT INTO public.pump_conflict (id, kind, job_date, order_id, job_id, trip_id, plant_id, detail)
      VALUES (gen_random_uuid(), 'truck_before_pump', j.job_date, j.order_id, j.id, t.id, t.plant_id, 'a truck arrives before the pump is ready')
      ON CONFLICT DO NOTHING;
      IF FOUND THEN
        v_n := v_n + 1;
        PERFORM public.notify('day_conflict', 'urgent', jsonb_build_object('kind', 'truck_before_pump'), '/pumps', t.plant_id,
                              ARRAY['owner', 'app_admin', 'plant_manager', 'office_sales'], NULL);
      END IF;
    END LOOP;
  END IF;
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._pump_check_job(uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.schedule_pump_job(p_date date, p_pump uuid, p_operator uuid, p_order uuid, p_on_site_min integer, p_setup_min integer,
                                         p_duration_min integer, p_site text, p_address_enc text, p_m3 integer) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_client uuid;
  v_site text := nullif(btrim(coalesce(p_site, '')), '');
  v_dur integer := p_duration_min;
BEGIN
  PERFORM public._pump_actor_check();
  IF NOT EXISTS (SELECT 1 FROM public.truck t WHERE t.id = p_pump AND t.kind = 'pump') THEN
    RAISE EXCEPTION 'pump: not a pump truck' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver d WHERE d.id = p_operator AND d.kind = 'pump_operator' AND d.status = 'active') THEN
    RAISE EXCEPTION 'pump: not a pump operator' USING ERRCODE = 'check_violation';
  END IF;
  IF p_on_site_min IS NULL THEN RAISE EXCEPTION 'pump: the time on site is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_order IS NOT NULL THEN
    SELECT o.client_id INTO v_client FROM public.sales_order o
     WHERE o.id = p_order AND o.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id);
    IF NOT FOUND THEN RAISE EXCEPTION 'pump: not a live order' USING ERRCODE = 'check_violation'; END IF;
    IF v_site IS NULL THEN v_site := (SELECT s.label FROM public.sales_order o JOIN public.client_site s ON s.id = o.site_id WHERE o.id = p_order); END IF;
  END IF;
  IF v_site IS NULL THEN RAISE EXCEPTION 'pump: the site is required' USING ERRCODE = 'check_violation'; END IF;
  -- The pumping duration, when not given, follows the quantity at a market rate of 30 m3 an hour (at least 30 minutes).
  IF v_dur IS NULL AND p_m3 IS NOT NULL THEN v_dur := GREATEST(30, ceil(p_m3 * 60.0 / 30)::integer); END IF;
  INSERT INTO public.pump_job (id, job_date, pump_id, operator_id, client_id, site_label, address_enc, planned_m3, created_by,
                               order_id, on_site_min, setup_min, duration_min)
  VALUES (v_id, p_date, p_pump, p_operator, v_client, v_site, p_address_enc, p_m3, ctx.user_id(),
          p_order, p_on_site_min, coalesce(p_setup_min, 30), v_dur);
  IF p_order IS NOT NULL THEN
    INSERT INTO public.order_pump (order_id, pumped, updated_by) VALUES (p_order, true, ctx.user_id())
      ON CONFLICT (order_id) DO UPDATE SET pumped = true, updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  PERFORM public._pump_check_job(v_id);
  RETURN v_id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.reschedule_pump_job(p_job uuid, p_on_site_min integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._pump_actor_check();
  IF p_on_site_min IS NULL OR p_on_site_min NOT BETWEEN 0 AND 1439 THEN
    RAISE EXCEPTION 'pump: the time on site is invalid' USING ERRCODE = 'check_violation';
  END IF;
  -- A job already started (any step reported) is not moved.
  IF EXISTS (SELECT 1 FROM public.pump_job_event e WHERE e.job_id = p_job) THEN
    RAISE EXCEPTION 'pump: the pump job has started' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.pump_job SET on_site_min = p_on_site_min WHERE id = p_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'pump: unknown pump job' USING ERRCODE = 'check_violation'; END IF;
  -- The conflicts of the old time are over; the new time is checked again.
  UPDATE public.pump_conflict SET resolved_at = now(), resolved_by = ctx.user_id()
   WHERE resolved_at IS NULL AND (job_id = p_job OR other_job_id = p_job);
  PERFORM public._pump_check_job(p_job);
  RETURN true;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.resolve_pump_conflict(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._pump_actor_check();
  UPDATE public.pump_conflict SET resolved_at = now(), resolved_by = ctx.user_id() WHERE id = p_id AND resolved_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- A truck is not planned for a pumped pour before a pump is scheduled on site (refused), and one planned to arrive before the pump is
-- ready is a conflict (allowed, recorded, alerted). Cancelled and replanned rotations pass through the same checks when re-inserted.
CREATE FUNCTION public.trip_plan_pump_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_pump p WHERE p.order_id = NEW.order_id AND p.pumped)
     AND NOT EXISTS (SELECT 1 FROM public.pump_job j WHERE j.order_id = NEW.order_id AND j.job_date = NEW.trip_date AND j.on_site_min IS NOT NULL) THEN
    RAISE EXCEPTION 'dispatch: the pour is pumped and no pump is scheduled on site yet' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_trip_plan_pump_guard BEFORE INSERT ON public.trip_plan FOR EACH ROW EXECUTE FUNCTION public.trip_plan_pump_guard();
--> statement-breakpoint
CREATE FUNCTION public.trip_plan_pump_conflict() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j record;
BEGIN
  FOR j IN SELECT x.id, x.on_site_min, x.setup_min FROM public.pump_job x
            WHERE x.order_id = NEW.order_id AND x.job_date = NEW.trip_date AND x.on_site_min IS NOT NULL LOOP
    IF NEW.arrive_min < j.on_site_min + j.setup_min THEN
      INSERT INTO public.pump_conflict (id, kind, job_date, order_id, job_id, trip_id, plant_id, detail)
      VALUES (gen_random_uuid(), 'truck_before_pump', NEW.trip_date, NEW.order_id, j.id, NEW.id, NEW.plant_id, 'a truck arrives before the pump is ready')
      ON CONFLICT DO NOTHING;
      IF FOUND THEN
        PERFORM public.notify('day_conflict', 'urgent', jsonb_build_object('kind', 'truck_before_pump'), '/pumps', NEW.plant_id,
                              ARRAY['owner', 'app_admin', 'plant_manager', 'office_sales'], NULL);
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_plan_pump_conflict AFTER INSERT ON public.trip_plan FOR EACH ROW EXECUTE FUNCTION public.trip_plan_pump_conflict();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_plan_pump_guard(), public.trip_plan_pump_conflict() FROM PUBLIC;
--> statement-breakpoint

-- The day's pump board: each job with its window, its order and the first truck planned for the order.
CREATE FUNCTION public.pump_board(p_date date) RETURNS TABLE(
  job_id uuid, pump_code text, operator_name text, order_id uuid, order_code text, client_name text, site_label text,
  on_site_min integer, setup_min integer, duration_min integer, planned_m3 integer, first_truck_arrive_min integer, open_conflicts integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager', 'support') THEN
    RAISE EXCEPTION 'pump_board: role % may not read it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT j.id, k.code, d.name, j.order_id, o.code, c.name, j.site_label, j.on_site_min, j.setup_min, j.duration_min, j.planned_m3,
           (SELECT min(p.arrive_min) FROM public.trip_plan p
             WHERE p.order_id = j.order_id AND p.trip_date = j.job_date
               AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id))::integer,
           (SELECT count(*)::integer FROM public.pump_conflict f WHERE (f.job_id = j.id OR f.other_job_id = j.id) AND f.resolved_at IS NULL)
      FROM public.pump_job j
      JOIN public.truck k ON k.id = j.pump_id
      JOIN public.driver d ON d.id = j.operator_id
      LEFT JOIN public.sales_order o ON o.id = j.order_id
      LEFT JOIN public.client c ON c.id = j.client_id
     WHERE j.job_date = p_date
     ORDER BY j.on_site_min NULLS LAST, k.code;
END $$;
--> statement-breakpoint
-- Pumped orders of the day with no pump scheduled yet: no truck can be planned for them.
CREATE FUNCTION public.pump_waiting(p_date date) RETURNS TABLE(order_id uuid, order_code text, client_name text, volume_l integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager', 'support') THEN
    RAISE EXCEPTION 'pump_waiting: role % may not read it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT o.id, o.code, c.name, o.volume_l
      FROM public.order_pump p JOIN public.sales_order o ON o.id = p.order_id JOIN public.client c ON c.id = o.client_id
     WHERE p.pumped AND o.delivery_date = p_date AND o.reverses_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM public.pump_job j WHERE j.order_id = o.id AND j.job_date = p_date AND j.on_site_min IS NOT NULL)
       AND (ctx.plant_scope() IS NULL OR o.plant_id IS NULL OR o.plant_id = ctx.plant_scope())
     ORDER BY o.code;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.pump_conflicts(p_date date) RETURNS TABLE(
  id uuid, kind text, order_code text, pump_code text, other_pump_code text, trip_arrive_min integer, on_site_min integer, setup_min integer,
  created_at timestamptz, resolved_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager', 'support') THEN
    RAISE EXCEPTION 'pump_conflicts: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT f.id, f.kind, o.code, k.code, k2.code, t.arrive_min, j.on_site_min, j.setup_min, f.created_at, f.resolved_at
      FROM public.pump_conflict f
      JOIN public.pump_job j ON j.id = f.job_id
      JOIN public.truck k ON k.id = j.pump_id
      LEFT JOIN public.pump_job j2 ON j2.id = f.other_job_id
      LEFT JOIN public.truck k2 ON k2.id = j2.pump_id
      LEFT JOIN public.sales_order o ON o.id = f.order_id
      LEFT JOIN public.trip_plan t ON t.id = f.trip_id
     WHERE f.job_date = p_date AND (ctx.plant_scope() IS NULL OR f.plant_id IS NULL OR f.plant_id = ctx.plant_scope())
     ORDER BY f.resolved_at IS NOT NULL, f.created_at;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'set_order_pumped(uuid, boolean)',
    'schedule_pump_job(date, uuid, uuid, uuid, integer, integer, integer, text, text, integer)',
    'reschedule_pump_job(uuid, integer)', 'resolve_pump_conflict(uuid)',
    'pump_board(date)', 'pump_waiting(date)', 'pump_conflicts(date)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
END $$;
