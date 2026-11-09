-- T9b addendum (owner, 9 Nov 2026): (1) the narrow right to CORRECT a stage's time (`trips.correct`) is also held by office_sales, for any trip, and by nothing else new:
-- it gives no dispatch power (no planning, no reassignment, no postponement) and no read of the board. (2) A phone number per plant (nullable), set only by the owner
-- and app_admin (audited), and shown to the driver of that plant's rotations as a tel: link. Forward only.

ALTER TABLE public.trip_event_correction DROP CONSTRAINT trip_event_correction_actor_role_check;
--> statement-breakpoint
ALTER TABLE public.trip_event_correction
  ADD CONSTRAINT trip_event_correction_actor_role_check CHECK (actor_role IN ('plant', 'plant_manager', 'owner', 'app_admin', 'office_sales'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.correct_trip_stage(p_trip uuid, p_stage text, p_time timestamptz, p_reason text) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_steps text[] := ARRAY['loading_started', 'loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'];
  v_index integer := array_position(v_steps, p_stage);
  v_role  text := ctx.actor_role();
  v_trip  public.trip_plan%ROWTYPE;
  v_cur   timestamptz;
  v_eid   uuid;
  v_prev  timestamptz;
  v_next  timestamptz;
BEGIN
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;
  IF NOT FOUND OR ctx.user_id() IS NULL OR ctx.driver_id() IS NOT NULL OR NOT (
       v_role IN ('owner', 'app_admin', 'plant', 'office_sales')
       OR (v_role = 'plant_manager' AND v_trip.plant_id IS NOT NULL AND v_trip.plant_id = ctx.plant_scope())) THEN
    RAISE EXCEPTION 'correct_trip_stage: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_index IS NULL OR p_time IS NULL THEN
    RAISE EXCEPTION 'correct_trip_stage: unknown stage' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR p_reason <> btrim(p_reason) OR length(p_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'correct_trip_stage: a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || p_trip::text, 0));
  SELECT e.id, coalesce((SELECT c.corrected_at FROM public.trip_event_correction c WHERE c.trip_id = e.trip_id AND c.step = e.step
                    ORDER BY c.created_at DESC, c.id DESC LIMIT 1), e.at)
    INTO v_eid, v_cur FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = p_stage;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correct_trip_stage: the stage is not recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF v_index > 1 THEN
    SELECT coalesce((SELECT c.corrected_at FROM public.trip_event_correction c WHERE c.trip_id = e.trip_id AND c.step = e.step
                      ORDER BY c.created_at DESC, c.id DESC LIMIT 1), e.at)
      INTO v_prev FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = v_steps[v_index - 1];
  END IF;
  IF v_index < array_length(v_steps, 1) THEN
    SELECT coalesce((SELECT c.corrected_at FROM public.trip_event_correction c WHERE c.trip_id = e.trip_id AND c.step = e.step
                      ORDER BY c.created_at DESC, c.id DESC LIMIT 1), e.at)
      INTO v_next FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = v_steps[v_index + 1];
  END IF;
  IF (v_prev IS NOT NULL AND p_time < v_prev) OR (v_next IS NOT NULL AND p_time > v_next) OR p_time > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'correct_trip_stage: breaks the order of the stages' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.trip_event_correction (id, trip_id, step, corrected_at, previous_at, reason, actor_id, actor_role)
  VALUES (gen_random_uuid(), p_trip, p_stage, p_time, v_cur, p_reason, ctx.user_id(),
          v_role);
  -- the correction is also a service event of the hash-chained audit log, with its reason in the reason column
  PERFORM audit.record('reverse', 'trip_event', v_eid::text,
                       jsonb_build_object('step', p_stage, 'at', v_cur), jsonb_build_object('step', p_stage, 'at', p_time), p_reason);
  RETURN p_time;
END $$;
--> statement-breakpoint
--> statement-breakpoint

ALTER TABLE public.plant ADD COLUMN phone text CHECK (phone IS NULL OR (phone = btrim(phone) AND length(phone) BETWEEN 3 AND 40));
--> statement-breakpoint
CREATE POLICY plant_phone_definer ON public.plant FOR UPDATE TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Only the owner and app_admin set it; an empty text clears it. The change is audited by the plant table's capture trigger (actor, before, after).
CREATE FUNCTION public.set_plant_phone(p_plant uuid, p_phone text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role();
BEGIN
  IF ctx.driver_id() IS NOT NULL OR v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'app_admin' THEN
    RAISE EXCEPTION 'set_plant_phone: role % may not set a plant phone', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.plant p SET phone = nullif(btrim(p_phone), '') WHERE p.id = p_plant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_plant_phone: unknown plant' USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.set_plant_phone(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_plant_phone(uuid, text) TO belgobeton_app;
--> statement-breakpoint

-- The plant phone of each of the driver's own rotations of a day: that number and nothing else of the plant.
CREATE FUNCTION public.driver_plant_phones(p_date date) RETURNS TABLE(trip_id uuid, phone text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_plant_phones: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT p.id, pl.phone FROM public.trip_plan p JOIN public.plant pl ON pl.id = p.plant_id
   WHERE p.driver_id = v_driver AND p.trip_date = p_date AND pl.phone IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.driver_plant_phones(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.driver_plant_phones(date) TO belgobeton_app;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.correct_trip_stage(uuid, text, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correct_trip_stage(uuid, text, timestamptz, text) TO belgobeton_app;
