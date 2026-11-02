-- R4 (CP-PROD-PLAN, REQUIREMENTS-V1 §7; DECISIONS 135, 141): the driver and pump phone app.
-- A driver is a `driver` row linked to a user of role driver (or pump_operator). The user has no usable password: the phone
-- signs in with a short PIN and a bound device (tables below, reachable by belgobeton_auth only). Everything the phone reads
-- or writes goes through the reviewed doors below, each checking ctx.actor_role() and the caller's own driver id. No price,
-- total or balance exists in any of their results.

ALTER TABLE public.driver
  ADD COLUMN user_id text UNIQUE REFERENCES public."user"(id),
  ADD COLUMN kind text NOT NULL DEFAULT 'driver' CHECK (kind IN ('driver', 'pump_operator'));
--> statement-breakpoint
GRANT UPDATE (user_id) ON public.driver TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY driver_update_link ON public.driver FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner')) WITH CHECK (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint

-- PIN and devices: authentication data, belgobeton_auth only (like sessions).
CREATE TABLE public.driver_pin (
  driver_id    uuid PRIMARY KEY REFERENCES public.driver(id),
  pin_hash     text NOT NULL,
  failed       integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  set_by       text NOT NULL,
  set_at       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.driver_device (
  id          uuid PRIMARY KEY,
  driver_id   uuid NOT NULL REFERENCES public.driver(id),
  device_hash text NOT NULL,
  label       text,
  bound_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  text
);
--> statement-breakpoint
-- One live device per driver: a second phone needs the first one revoked by the owner or app_admin.
CREATE UNIQUE INDEX driver_device_one_live ON public.driver_device (driver_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
REVOKE ALL ON public.driver_pin, public.driver_device FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.driver_pin, public.driver_device TO belgobeton_auth;
--> statement-breakpoint

-- The caller's own driver id (null for anybody else).
CREATE FUNCTION ctx.driver_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id FROM public.driver d
   WHERE d.user_id = ctx.user_id()::text AND d.status = 'active' AND ctx.actor_role() IN ('driver', 'pump_operator')
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.driver_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.driver_id() TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint

-- What the driver reports that the plant's tracking does not hold: loading started, and the m³ really unloaded.
CREATE TABLE public.trip_driver_report (
  id         uuid PRIMARY KEY,
  trip_id    uuid NOT NULL REFERENCES public.trip_plan(id),
  driver_id  uuid NOT NULL REFERENCES public.driver(id),
  kind       text NOT NULL CHECK (kind IN ('loading_started', 'unloaded')),
  at         timestamptz NOT NULL,
  volume_l   integer CHECK (volume_l BETWEEN 1 AND 100000),
  client_key text NOT NULL CHECK (length(client_key) BETWEEN 8 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, kind),
  UNIQUE (driver_id, client_key),
  CHECK ((kind = 'unloaded') = (volume_l IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE public.trip_emergency (
  id          uuid PRIMARY KEY,
  trip_id     uuid NOT NULL REFERENCES public.trip_plan(id),
  driver_id   uuid NOT NULL REFERENCES public.driver(id),
  step        text NOT NULL,
  option      text NOT NULL CHECK (option IN ('breakdown', 'accident', 'wrong_load', 'heavy_delay', 'client_cancelled', 'site_closed',
                                              'site_not_ready', 'load_not_enough', 'client_stopped', 'quality_refused')),
  pct_unloaded integer CHECK (pct_unloaded BETWEEN 0 AND 100),
  note        text CHECK (note IS NULL OR length(note) <= 300),
  at          timestamptz NOT NULL,
  client_key  text NOT NULL CHECK (length(client_key) BETWEEN 8 AND 80),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, client_key)
);
--> statement-breakpoint
CREATE TABLE public.trip_instruction (
  id              uuid PRIMARY KEY,
  emergency_id    uuid NOT NULL REFERENCES public.trip_emergency(id),
  trip_id         uuid NOT NULL REFERENCES public.trip_plan(id),
  kind            text NOT NULL CHECK (kind IN ('continue', 'extra_load', 'redirect', 'join')),
  address_enc     text,
  map_url         text CHECK (map_url IS NULL OR map_url ~ '^https://'),
  note            text CHECK (note IS NULL OR length(note) <= 300),
  join_trip_id    uuid REFERENCES public.trip_plan(id),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  CHECK (kind <> 'redirect' OR address_enc IS NOT NULL OR map_url IS NOT NULL),
  CHECK (kind <> 'join' OR join_trip_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE public.pump_job (
  id          uuid PRIMARY KEY,
  job_date    date NOT NULL,
  pump_id     uuid NOT NULL REFERENCES public.truck(id),
  operator_id uuid NOT NULL REFERENCES public.driver(id),
  client_id   uuid REFERENCES public.client(id),
  site_label  text NOT NULL CHECK (length(site_label) BETWEEN 1 AND 120),
  address_enc text,
  planned_m3  integer CHECK (planned_m3 BETWEEN 1 AND 500),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.pump_job_event (
  id         uuid PRIMARY KEY,
  job_id     uuid NOT NULL REFERENCES public.pump_job(id),
  step       text NOT NULL CHECK (step IN ('arrived', 'set_up', 'pumping_started', 'pumping_ended', 'left')),
  at         timestamptz NOT NULL,
  m3_pumped  integer CHECK (m3_pumped BETWEEN 1 AND 500),
  client_key text NOT NULL CHECK (length(client_key) BETWEEN 8 AND 80),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, step),
  UNIQUE (created_by, client_key),
  CHECK ((step = 'pumping_ended') = (m3_pumped IS NOT NULL))
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_driver_report', 'trip_emergency', 'trip_instruction', 'pump_job', 'pump_job_event'] LOOP
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
CREATE POLICY trip_event_definer_insert ON public.trip_event FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

-- 1. The driver's day: their own rotations, with what is needed on the road. No price, no amount, no order total.
CREATE FUNCTION public.driver_trips(p_date date) RETURNS TABLE(
  trip_id uuid, seq integer, order_code text, type_label text, volume_l integer, client_name text, contact_name text,
  phone_enc text, site_label text, address_enc text, zone_name text, truck_code text, load_min integer, bl_no text,
  steps json, loading_started_at timestamptz, unloaded_l integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_trips: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT p.id, p.seq, o.code, t.label, p.volume_l, c.name, c.contact_name, c.phone_enc, s.label, s.address_enc, z.name,
         k.code, p.load_min,
         (SELECT dl.bl_no FROM public.trip_event e JOIN public.delivery dl ON dl.id = e.delivery_id WHERE e.trip_id = p.id AND e.step = 'loaded'),
         coalesce((SELECT json_agg(json_build_object('step', e.step, 'at', e.at) ORDER BY e.created_at) FROM public.trip_event e WHERE e.trip_id = p.id), '[]'::json),
         (SELECT r.at FROM public.trip_driver_report r WHERE r.trip_id = p.id AND r.kind = 'loading_started'),
         (SELECT r.volume_l FROM public.trip_driver_report r WHERE r.trip_id = p.id AND r.kind = 'unloaded')
    FROM public.trip_plan p
    JOIN public.sales_order o ON o.id = p.order_id
    JOIN public.client c ON c.id = o.client_id
    JOIN public.concrete_type t ON t.id = o.concrete_type_id
    JOIN public.truck k ON k.id = p.truck_id
    LEFT JOIN public.client_site s ON s.id = o.site_id
    LEFT JOIN public.zone z ON z.id = o.zone_id
   WHERE p.driver_id = v_driver AND p.trip_date = p_date
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
   ORDER BY p.load_min, p.seq;
END $$;
--> statement-breakpoint

-- 2. One tap, one step. Idempotent on the phone's key (an offline queue may replay it); the time is the phone's, bounded.
CREATE FUNCTION public.driver_report(p_trip uuid, p_step text, p_at timestamptz, p_key text, p_volume_l integer) RETURNS text
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
  -- a replay of a tap already stored (same key) changes nothing
  IF EXISTS (SELECT 1 FROM public.trip_driver_report r WHERE r.driver_id = v_driver AND r.client_key = p_key)
     OR EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = p_step AND e.created_by = ctx.user_id()) THEN
    RETURN 'replayed';
  END IF;
  IF p_step = 'loading_started' THEN
    INSERT INTO public.trip_driver_report (id, trip_id, driver_id, kind, at, client_key)
    VALUES (gen_random_uuid(), p_trip, v_driver, 'loading_started', p_at, p_key)
    ON CONFLICT (trip_id, kind) DO NOTHING;
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
    RETURN 'recorded';
  END IF;
  RAISE EXCEPTION 'driver_report: unknown step' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint

-- 3. The emergency button: its options depend on the step the rotation is at.
CREATE FUNCTION public.driver_emergency(p_trip uuid, p_option text, p_pct integer, p_note text, p_key text, p_at timestamptz) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_driver uuid := ctx.driver_id();
  v_step   text;
  v_id     uuid;
  v_ok     boolean;
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_emergency: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = p_trip AND p.driver_id = v_driver) THEN
    RAISE EXCEPTION 'driver_emergency: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id INTO v_id FROM public.trip_emergency WHERE driver_id = v_driver AND client_key = p_key;
  IF FOUND THEN RETURN 'replayed'; END IF;
  SELECT e.step INTO v_step FROM public.trip_event e WHERE e.trip_id = p_trip ORDER BY e.at DESC, e.created_at DESC LIMIT 1;
  v_step := coalesce(v_step, 'start');
  v_ok := (v_step IN ('start', 'loaded') AND p_option IN ('breakdown', 'accident', 'wrong_load'))
       OR (v_step = 'departed' AND p_option IN ('breakdown', 'accident', 'heavy_delay', 'client_cancelled', 'site_closed'))
       OR (v_step = 'arrived' AND p_option IN ('site_not_ready', 'site_closed', 'client_cancelled', 'breakdown'))
       OR (v_step = 'unloading_started' AND p_option IN ('load_not_enough', 'client_stopped', 'site_not_ready', 'quality_refused', 'breakdown'))
       OR (v_step IN ('unloading_finished', 'back') AND p_option IN ('breakdown', 'accident', 'heavy_delay'));
  IF NOT v_ok THEN
    RAISE EXCEPTION 'driver_emergency: this option does not exist at this step' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.trip_emergency (id, trip_id, driver_id, step, option, pct_unloaded, note, at, client_key)
  VALUES (gen_random_uuid(), p_trip, v_driver, v_step, p_option, p_pct, nullif(btrim(p_note), ''), p_at, p_key);
  RETURN 'recorded';
END $$;
--> statement-breakpoint

-- 4. What the office told the driver, and the acknowledgement.
CREATE FUNCTION public.driver_instructions() RETURNS TABLE(
  id uuid, trip_id uuid, kind text, address_enc text, map_url text, note text, join_truck_code text, created_at timestamptz, acknowledged_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_instructions: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT i.id, i.trip_id, i.kind, i.address_enc, i.map_url, i.note,
         (SELECT k.code FROM public.trip_plan jp JOIN public.truck k ON k.id = jp.truck_id WHERE jp.id = i.join_trip_id),
         i.created_at, i.acknowledged_at
    FROM public.trip_instruction i JOIN public.trip_plan p ON p.id = i.trip_id
   WHERE p.driver_id = v_driver AND i.created_at > now() - interval '3 days'
   ORDER BY i.created_at DESC;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.driver_ack(p_instruction uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_ack: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.trip_instruction i SET acknowledged_at = coalesce(i.acknowledged_at, now())
   FROM public.trip_plan p WHERE i.id = p_instruction AND p.id = i.trip_id AND p.driver_id = v_driver;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver_ack: not your instruction' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint

-- 5. The office side: open emergencies, and an instruction (continue, extra load, redirect, join).
CREATE FUNCTION public.emergencies_open() RETURNS TABLE(
  id uuid, trip_id uuid, step text, option text, pct_unloaded integer, note text, at timestamptz, driver_name text,
  truck_code text, order_code text, client_name text, site_label text, volume_l integer, resolved_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant', 'support') THEN
    RAISE EXCEPTION 'emergencies_open: role % may not read emergencies', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT e.id, e.trip_id, e.step, e.option, e.pct_unloaded, e.note, e.at, d.name, k.code, o.code, c.name, s.label, p.volume_l, e.resolved_at
    FROM public.trip_emergency e
    JOIN public.trip_plan p ON p.id = e.trip_id
    JOIN public.driver d ON d.id = e.driver_id
    JOIN public.truck k ON k.id = p.truck_id
    JOIN public.sales_order o ON o.id = p.order_id
    JOIN public.client c ON c.id = o.client_id
    LEFT JOIN public.client_site s ON s.id = o.site_id
   WHERE (e.resolved_at IS NULL OR e.resolved_at > now() - interval '1 day')
     AND (ctx.plant_scope() IS NULL OR p.plant_id IS NULL OR p.plant_id = ctx.plant_scope())
   ORDER BY e.resolved_at IS NOT NULL, e.at DESC;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.emergency_instruct(p_emergency uuid, p_kind text, p_address_enc text, p_map_url text, p_note text, p_join_trip uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid := gen_random_uuid(); v_trip uuid;
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant') THEN
    RAISE EXCEPTION 'emergency_instruct: role % may not instruct', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT e.trip_id INTO v_trip FROM public.trip_emergency e WHERE e.id = p_emergency FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'emergency_instruct: unknown emergency' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.trip_instruction (id, emergency_id, trip_id, kind, address_enc, map_url, note, join_trip_id, created_by)
  VALUES (v_id, p_emergency, v_trip, p_kind, p_address_enc, p_map_url, nullif(btrim(p_note), ''), p_join_trip, ctx.user_id());
  UPDATE public.trip_emergency SET resolved_at = coalesce(resolved_at, now()) WHERE id = p_emergency;
  RETURN v_id;
END $$;
--> statement-breakpoint

-- 6. The pump operator's day, and its five steps.
CREATE FUNCTION public.create_pump_job(p_date date, p_pump uuid, p_operator uuid, p_client uuid, p_site text, p_address_enc text, p_m3 integer) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant') THEN
    RAISE EXCEPTION 'create_pump_job: role % may not plan a pump', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.truck t WHERE t.id = p_pump AND t.kind = 'pump') THEN
    RAISE EXCEPTION 'create_pump_job: not a pump truck' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver d WHERE d.id = p_operator AND d.kind = 'pump_operator' AND d.status = 'active') THEN
    RAISE EXCEPTION 'create_pump_job: not a pump operator' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.pump_job (id, job_date, pump_id, operator_id, client_id, site_label, address_enc, planned_m3, created_by)
  VALUES (v_id, p_date, p_pump, p_operator, p_client, btrim(p_site), p_address_enc, p_m3, ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.pump_jobs(p_date date) RETURNS TABLE(
  job_id uuid, pump_code text, client_name text, site_label text, address_enc text, planned_m3 integer, steps json, m3_pumped integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'pump_jobs: not an operator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT j.id, k.code, c.name, j.site_label, j.address_enc, j.planned_m3,
         coalesce((SELECT json_agg(json_build_object('step', e.step, 'at', e.at) ORDER BY e.at) FROM public.pump_job_event e WHERE e.job_id = j.id), '[]'::json),
         (SELECT e.m3_pumped FROM public.pump_job_event e WHERE e.job_id = j.id AND e.step = 'pumping_ended')
    FROM public.pump_job j JOIN public.truck k ON k.id = j.pump_id LEFT JOIN public.client c ON c.id = j.client_id
   WHERE j.operator_id = v_driver AND j.job_date = p_date
   ORDER BY j.created_at;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.pump_report(p_job uuid, p_step text, p_at timestamptz, p_key text, p_m3 integer) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_driver uuid := ctx.driver_id();
  v_steps  text[] := ARRAY['arrived', 'set_up', 'pumping_started', 'pumping_ended', 'left'];
  v_idx    integer := array_position(ARRAY['arrived', 'set_up', 'pumping_started', 'pumping_ended', 'left'], p_step);
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'pump_report: not an operator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pump_job j WHERE j.id = p_job AND j.operator_id = v_driver) THEN
    RAISE EXCEPTION 'pump_report: not your job' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_idx IS NULL OR p_at > now() + interval '5 minutes' OR p_at < now() - interval '48 hours' THEN
    RAISE EXCEPTION 'pump_report: invalid step or time' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pump_job_event e WHERE e.created_by = ctx.user_id() AND e.client_key = p_key)
     OR EXISTS (SELECT 1 FROM public.pump_job_event e WHERE e.job_id = p_job AND e.step = p_step) THEN
    RETURN 'replayed';
  END IF;
  IF v_idx > 1 AND NOT EXISTS (SELECT 1 FROM public.pump_job_event e WHERE e.job_id = p_job AND e.step = v_steps[v_idx - 1]) THEN
    RAISE EXCEPTION 'pump_report: the previous step is not recorded' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.pump_job_event (id, job_id, step, at, m3_pumped, client_key, created_by)
  VALUES (gen_random_uuid(), p_job, p_step, p_at, CASE WHEN p_step = 'pumping_ended' THEN p_m3 END, p_key, ctx.user_id());
  RETURN 'recorded';
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'driver_trips(date)', 'driver_report(uuid, text, timestamptz, text, integer)',
    'driver_emergency(uuid, text, integer, text, text, timestamptz)', 'driver_instructions()', 'driver_ack(uuid)',
    'emergencies_open()', 'emergency_instruct(uuid, text, text, text, text, uuid)',
    'create_pump_job(date, uuid, uuid, uuid, text, text, integer)', 'pump_jobs(date)', 'pump_report(uuid, text, timestamptz, text, integer)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
END $$;
