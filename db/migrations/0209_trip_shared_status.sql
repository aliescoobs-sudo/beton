-- T9 (docs/T9-TRIP-SHARED-STATUS.md): ONE shared status for a rotation, recorded by the driver and by the plant in the same table.
-- Forward only. `trip_event` is evolved (it is the existing, audited, insert-only log of a rotation): seven stages, who and how each row was
-- recorded, forward-only writes with an implicit fill, idempotent and race-safe writers, and corrections as new rows.
-- A stage is operational tracking only. Nothing in this file lets a driver's tap write a delivery, a stock movement, a delivered row or any
-- money row: the plant's own load (the BL and the stock) stays the plant's record, and the "delivered" mark follows a stage only when it is
-- the plant's (or an administrator's) explicit one.

-- 1. The table: the seventh stage (the driver's first tap), the author and the way, the phone's time, the implicit flag, the replay key.
ALTER TABLE public.trip_event
  ADD COLUMN actor_role text,
  ADD COLUMN source text NOT NULL DEFAULT 'plant',
  ADD COLUMN client_time timestamptz,
  ADD COLUMN implicit boolean NOT NULL DEFAULT false,
  ADD COLUMN client_key text;
--> statement-breakpoint
ALTER TABLE public.trip_event DROP CONSTRAINT trip_event_step_check;
--> statement-breakpoint
ALTER TABLE public.trip_event DROP CONSTRAINT trip_event_check;
--> statement-breakpoint
ALTER TABLE public.trip_event
  ADD CONSTRAINT trip_event_step_check CHECK (step IN ('loading_started', 'loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back')),
  ADD CONSTRAINT trip_event_load_check CHECK (delivery_id IS NULL OR step = 'loaded'),
  ADD CONSTRAINT trip_event_source_check CHECK (source IN ('driver', 'plant', 'admin')),
  ADD CONSTRAINT trip_event_actor_role_check CHECK (actor_role IS NULL OR actor_role IN ('driver', 'plant', 'plant_manager', 'owner', 'app_admin')),
  ADD CONSTRAINT trip_event_client_key_check CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 80),
  ADD CONSTRAINT trip_event_implicit_check CHECK (NOT implicit OR (client_key IS NULL AND client_time IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX trip_event_client_key_idx ON public.trip_event (trip_id, client_key) WHERE client_key IS NOT NULL;
--> statement-breakpoint

-- 2. Corrections are new rows that supersede a stage's time; the stage row is never touched. Insert-only, audited.
CREATE TABLE public.trip_event_correction (
  id           uuid PRIMARY KEY,
  trip_id      uuid NOT NULL,
  step         text NOT NULL CHECK (step IN ('loading_started', 'loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back')),
  corrected_at timestamptz NOT NULL,
  -- the effective time of the stage just before this correction (the original, or the previous correction)
  previous_at  timestamptz NOT NULL,
  reason       text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  actor_id     uuid NOT NULL,
  actor_role   text NOT NULL CHECK (actor_role IN ('plant', 'plant_manager', 'owner', 'app_admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (trip_id, step) REFERENCES public.trip_event (trip_id, step)
);
--> statement-breakpoint
CREATE INDEX trip_event_correction_idx ON public.trip_event_correction (trip_id, step, created_at DESC);
--> statement-breakpoint
ALTER TABLE public.trip_event_correction ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trip_event_correction FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.trip_event_correction FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.trip_event_correction TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY trip_event_correction_read ON public.trip_event_correction FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'plant')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = trip_event_correction.trip_id AND p.plant_id = ctx.plant_scope())));
--> statement-breakpoint
CREATE POLICY trip_event_correction_definer ON public.trip_event_correction FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER trip_event_correction_append_only BEFORE UPDATE OR DELETE ON public.trip_event_correction
  FOR EACH ROW EXECUTE FUNCTION public._forbid_change();
--> statement-breakpoint
SELECT audit.attach('public.trip_event_correction');
--> statement-breakpoint

-- 3. The guard: seven stages; the rotation is live; the previous stage is recorded and not later; a load (when there is one) is a live load
--    of this rotation's order and truck. A `loaded` stage may have NO load (declared by the driver).
CREATE OR REPLACE FUNCTION public.trip_event_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_trip   public.trip_plan%ROWTYPE;
  v_steps  text[] := ARRAY['loading_started', 'loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'];
  v_index  integer := array_position(v_steps, NEW.step);
  v_prev   public.trip_event%ROWTYPE;
  v_d      public.delivery%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || NEW.trip_id::text, 0));
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = NEW.trip_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = NEW.trip_id) THEN
    RAISE EXCEPTION 'trip_event: not a live rotation' USING ERRCODE = 'check_violation';
  END IF;
  -- `loading_started` is the driver's own first tap: the rows written before this migration (and the owner's direct inserts of fixtures) start at `loaded`
  IF v_index > 2 THEN
    SELECT * INTO v_prev FROM public.trip_event WHERE trip_id = NEW.trip_id AND step = v_steps[v_index - 1];
    IF NOT FOUND THEN
      RAISE EXCEPTION 'trip_event: the previous step is not recorded' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.at < v_prev.at THEN
      RAISE EXCEPTION 'trip_event: before the previous step' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.delivery_id IS NOT NULL THEN
    SELECT * INTO v_d FROM public.delivery WHERE id = NEW.delivery_id;
    IF NOT FOUND OR v_d.reverses_id IS NOT NULL OR v_d.order_id <> v_trip.order_id OR v_d.truck_id <> v_trip.truck_id
       OR EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = v_d.id) THEN
      RAISE EXCEPTION 'trip_event: not a live load of this rotation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 4. The table stays insert-only. The ONE update it ever allows: the plant's load linked, once, to a `loaded` stage that was declared without one.
CREATE FUNCTION public.trip_event_update_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_trip public.trip_plan%ROWTYPE;
  v_d    public.delivery%ROWTYPE;
BEGIN
  IF OLD.step = 'loaded' AND OLD.delivery_id IS NULL AND NEW.delivery_id IS NOT NULL
     AND (to_jsonb(NEW) - 'delivery_id') = (to_jsonb(OLD) - 'delivery_id') THEN
    SELECT * INTO v_trip FROM public.trip_plan WHERE id = NEW.trip_id;
    SELECT * INTO v_d FROM public.delivery WHERE id = NEW.delivery_id;
    IF NOT FOUND OR v_d.reverses_id IS NOT NULL OR v_d.order_id <> v_trip.order_id OR v_d.truck_id <> v_trip.truck_id
       OR EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = v_d.id) THEN
      RAISE EXCEPTION 'trip_event: not a live load of this rotation' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'trip_event is insert-only (only the plant''s load may be linked to a declared loaded stage)' USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_event_update_guard BEFORE UPDATE ON public.trip_event
  FOR EACH ROW EXECUTE FUNCTION public.trip_event_update_guard();
--> statement-breakpoint
CREATE POLICY trip_event_definer_update ON public.trip_event FOR UPDATE TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint

-- 4b. The plant manager no longer inserts rows directly: every stage goes through record_trip_stage (role check, plant scope, implicit fill,
--     source). The direct door stays for the owner only (fixtures, the training day); it cannot break the guard above.
DROP POLICY trip_event_insert ON public.trip_event;
--> statement-breakpoint
CREATE POLICY trip_event_insert ON public.trip_event FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint

-- 5. Money and stock separation: the unloading stage delivers the plant's load (the invoice queue reads `delivery_delivered`) only when it is
--    the plant's or an administrator's own explicit stage. A stage declared by the driver, or filled in because a later one was recorded,
--    delivers nothing; the plant confirms it with confirm_trip_delivered().
CREATE OR REPLACE FUNCTION public.trip_event_delivered() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_delivery uuid;
BEGIN
  IF NEW.source = 'driver' OR NEW.implicit THEN
    RETURN NULL;
  END IF;
  SELECT l.delivery_id INTO v_delivery FROM public.trip_event l WHERE l.trip_id = NEW.trip_id AND l.step = 'loaded';
  IF v_delivery IS NOT NULL THEN
    INSERT INTO public.delivery_delivered (id, delivery_id, at, trip_event_id, created_by)
    VALUES (gen_random_uuid(), v_delivery, NEW.at, NEW.id, NEW.created_by);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- 6. The one writer of a stage. Positive authorization (an absent or unknown role is denied), the trip's lock first, then read-or-insert:
--    a stage already recorded is returned as it is (`o_recorded` false); a later stage fills the skipped earlier ones as implicit rows with the
--    same instant; the server's instant is authoritative (the phone's time is kept apart and only feeds the delay figures).
CREATE FUNCTION public.record_trip_stage(p_trip uuid, p_stage text, p_now timestamptz, p_client_time timestamptz, p_key text,
                                         p_delivery uuid DEFAULT NULL, p_reason text DEFAULT NULL)
  RETURNS TABLE(o_stage text, o_recorded boolean, o_at timestamptz, o_source text, o_actor_role text, o_implicit boolean, o_delivery_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_steps    text[] := ARRAY['loading_started', 'loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'];
  v_index    integer := array_position(v_steps, p_stage);
  v_role     text := ctx.actor_role();
  v_driver   uuid := ctx.driver_id();
  v_user     uuid := ctx.user_id();
  v_trip     public.trip_plan%ROWTYPE;
  v_source   text;
  v_arole    text;
  v_row      public.trip_event%ROWTYPE;
  v_last     timestamptz;
  v_at       timestamptz;
  v_eff      timestamptz;
  v_i        integer;
BEGIN
  IF v_index IS NULL THEN
    RAISE EXCEPTION 'record_trip_stage: unknown stage' USING ERRCODE = 'check_violation';
  END IF;
  IF v_user IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'record_trip_stage: no actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;
  -- one answer for "does not exist" and "not yours": the rotation of another driver or plant is not confirmed to exist
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_trip_stage: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_driver IS NOT NULL THEN
    IF v_trip.driver_id IS DISTINCT FROM v_driver THEN
      RAISE EXCEPTION 'record_trip_stage: not your rotation' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_source := 'driver'; v_arole := 'driver';
  ELSIF v_role = 'plant_manager' THEN
    IF v_trip.plant_id IS NULL OR v_trip.plant_id IS DISTINCT FROM ctx.plant_scope() THEN
      RAISE EXCEPTION 'record_trip_stage: not your rotation' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_source := 'plant'; v_arole := v_role;
  ELSIF v_role = 'plant' THEN
    -- the plant account that is not bound to one plant (as trip_started, migration 0208): any rotation, as the plant
    v_source := 'plant'; v_arole := v_role;
  ELSIF v_role IN ('owner', 'app_admin') THEN
    v_source := 'admin'; v_arole := v_role;
  ELSE
    RAISE EXCEPTION 'record_trip_stage: role % may not record a stage', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_delivery IS NOT NULL AND (p_stage <> 'loaded' OR v_source = 'driver') THEN
    RAISE EXCEPTION 'record_trip_stage: only the plant links a load, to the loaded stage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_source <> 'driver' AND p_client_time IS NOT NULL THEN
    RAISE EXCEPTION 'record_trip_stage: only a phone has a client time' USING ERRCODE = 'check_violation';
  END IF;
  IF p_client_time IS NOT NULL AND (p_client_time > p_now + interval '5 minutes' OR p_client_time < p_now - interval '48 hours') THEN
    RAISE EXCEPTION 'record_trip_stage: the time of the tap is not credible' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NOT NULL AND p_reason NOT IN ('traffic', 'site_wait', 'breakdown', 'other', '') THEN
    RAISE EXCEPTION 'record_trip_stage: unknown delay reason' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || p_trip::text, 0));
  IF EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = p_trip) THEN
    RAISE EXCEPTION 'record_trip_stage: not a live rotation' USING ERRCODE = 'check_violation';
  END IF;

  -- a replay of a tap already stored (same key), or the stage already there whoever recorded it: nothing changes
  IF p_key IS NOT NULL THEN
    SELECT * INTO v_row FROM public.trip_event e WHERE e.trip_id = p_trip AND e.client_key = p_key;
    IF FOUND THEN
      RETURN QUERY SELECT v_row.step, false, v_row.at, v_row.source, v_row.actor_role, v_row.implicit, v_row.delivery_id;
      RETURN;
    END IF;
  END IF;
  SELECT * INTO v_row FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = p_stage;
  IF FOUND THEN
    RETURN QUERY SELECT v_row.step, false, v_row.at, v_row.source, v_row.actor_role, v_row.implicit, v_row.delivery_id;
    RETURN;
  END IF;

  SELECT max(e.at) INTO v_last FROM public.trip_event e WHERE e.trip_id = p_trip;
  v_at := greatest(p_now, coalesce(v_last, p_now));
  v_eff := coalesce(p_client_time, v_at);

  FOR v_i IN 1 .. v_index - 1 LOOP
    IF NOT EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = v_steps[v_i]) THEN
      INSERT INTO public.trip_event (id, trip_id, step, at, delivery_id, created_by, actor_role, source, client_time, implicit, client_key, created_at)
      VALUES (gen_random_uuid(), p_trip, v_steps[v_i], v_at, NULL, v_user, v_arole, v_source, NULL, true, NULL, clock_timestamp());
    END IF;
  END LOOP;
  -- clock_timestamp(): the filled-in rows and the stage that caused them share one instant (`at`) but are written in order, so "the latest
  -- row" is the latest stage for every reader that sorts by `at, created_at` (driver_emergency, the cancellation flow)
  INSERT INTO public.trip_event (id, trip_id, step, at, delivery_id, created_by, actor_role, source, client_time, implicit, client_key, created_at)
  VALUES (gen_random_uuid(), p_trip, p_stage, v_at, p_delivery, v_user, v_arole, v_source, p_client_time, false, p_key, clock_timestamp())
  RETURNING * INTO v_row;

  -- the driver's report of "loading began" is still read by the timing figures (migration 0118): kept as a projection of this stage, never written alone
  IF p_stage = 'loading_started' AND v_trip.driver_id IS NOT NULL THEN
    INSERT INTO public.trip_driver_report (id, trip_id, driver_id, kind, at, client_key)
    VALUES (gen_random_uuid(), p_trip, v_trip.driver_id, 'loading_started', v_eff, coalesce(p_key, 'stage-' || gen_random_uuid()::text))
    ON CONFLICT (trip_id, kind) DO NOTHING;
  END IF;
  -- the delay of an explicit stage (not of a filled-in one) is recorded for the rotation's driver, whoever tapped
  IF v_trip.driver_id IS NOT NULL AND p_stage <> 'loaded' THEN
    PERFORM public._record_trip_delay(p_trip, v_trip.driver_id, p_stage, v_eff, p_reason);
  END IF;
  RETURN QUERY SELECT v_row.step, true, v_row.at, v_row.source, v_row.actor_role, v_row.implicit, v_row.delivery_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_trip_stage(uuid, text, timestamptz, timestamptz, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_trip_stage(uuid, text, timestamptz, timestamptz, text, uuid, text) TO belgobeton_app;
--> statement-breakpoint

-- 7. The driver's tap: same signature as before plus the server's instant; the same outcomes ('recorded' / 'replayed'). The stage itself is
--    written by record_trip_stage; the m3 the driver says he unloaded stays a declared figure (not a delivered quantity).
DROP FUNCTION public.driver_report(uuid, text, timestamptz, text, integer, text);
--> statement-breakpoint
CREATE FUNCTION public.driver_report(p_trip uuid, p_step text, p_at timestamptz, p_key text, p_volume_l integer, p_reason text DEFAULT NULL,
                                     p_now timestamptz DEFAULT NULL) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_driver uuid := ctx.driver_id();
  v_now    timestamptz := coalesce(p_now, now());
  v_out    record;
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_report: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = p_trip AND p.driver_id = v_driver) THEN
    RAISE EXCEPTION 'driver_report: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_at > v_now + interval '5 minutes' OR p_at < v_now - interval '48 hours' THEN
    RAISE EXCEPTION 'driver_report: the time of the tap is not credible' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NOT NULL AND p_reason NOT IN ('traffic', 'site_wait', 'breakdown', 'other', '') THEN
    RAISE EXCEPTION 'driver_report: unknown delay reason' USING ERRCODE = 'check_violation';
  END IF;
  IF p_step NOT IN ('loading_started', 'loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back') THEN
    RAISE EXCEPTION 'driver_report: unknown step' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_out FROM public.record_trip_stage(p_trip, p_step, v_now, p_at, p_key, NULL, p_reason);
  IF NOT v_out.o_recorded THEN
    RETURN 'replayed';
  END IF;
  IF p_step = 'unloading_finished' THEN
    -- the m3 he says he unloaded is required with the stage he taps himself (the exception rolls the stage back)
    IF p_volume_l IS NULL THEN
      RAISE EXCEPTION 'driver_report: the m3 unloaded is required' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.trip_driver_report (id, trip_id, driver_id, kind, at, volume_l, client_key)
    VALUES (gen_random_uuid(), p_trip, v_driver, 'unloaded', p_at, p_volume_l, p_key);
  END IF;
  RETURN 'recorded';
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.driver_report(uuid, text, timestamptz, text, integer, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.driver_report(uuid, text, timestamptz, text, integer, text, timestamptz) TO belgobeton_app;
--> statement-breakpoint

-- 8. The plant's load linked, once, to a stage the driver declared (or that was filled in). Called in the same transaction as the load.
CREATE FUNCTION public.attach_trip_load(p_trip uuid, p_delivery uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.actor_role();
  v_trip public.trip_plan%ROWTYPE;
BEGIN
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;
  IF NOT FOUND OR NOT (
       v_role IN ('owner', 'app_admin', 'plant')
       OR (v_role = 'plant_manager' AND v_trip.plant_id IS NOT NULL AND v_trip.plant_id = ctx.plant_scope())) THEN
    RAISE EXCEPTION 'attach_trip_load: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || p_trip::text, 0));
  UPDATE public.trip_event e SET delivery_id = p_delivery WHERE e.trip_id = p_trip AND e.step = 'loaded' AND e.delivery_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attach_trip_load: no declared loaded stage without a load' USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.attach_trip_load(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.attach_trip_load(uuid, uuid) TO belgobeton_app;
--> statement-breakpoint

-- 9. The plant confirms a delivery the driver declared. Needs the plant's own load; idempotent.
CREATE FUNCTION public.confirm_trip_delivered(p_trip uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.actor_role();
  v_trip public.trip_plan%ROWTYPE;
  v_fin  public.trip_event%ROWTYPE;
  v_load public.trip_event%ROWTYPE;
BEGIN
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;
  IF NOT FOUND OR NOT (
       v_role IN ('owner', 'app_admin', 'plant')
       OR (v_role = 'plant_manager' AND v_trip.plant_id IS NOT NULL AND v_trip.plant_id = ctx.plant_scope())) THEN
    RAISE EXCEPTION 'confirm_trip_delivered: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || p_trip::text, 0));
  SELECT * INTO v_fin FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'unloading_finished';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirm_trip_delivered: the unloading is not finished' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_load FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'loaded';
  IF NOT FOUND OR v_load.delivery_id IS NULL THEN
    RAISE EXCEPTION 'confirm_trip_delivered: the plant''s load is not recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_delivered d WHERE d.delivery_id = v_load.delivery_id) THEN
    RETURN false;
  END IF;
  INSERT INTO public.delivery_delivered (id, delivery_id, at, trip_event_id, created_by)
  VALUES (gen_random_uuid(), v_load.delivery_id, v_fin.at, v_fin.id, ctx.user_id());
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.confirm_trip_delivered(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.confirm_trip_delivered(uuid) TO belgobeton_app;
--> statement-breakpoint

-- 10. A correction: plant manager of the plant, owner, app_admin; a reason; the order of the stages kept; a new row, the stage untouched.
CREATE FUNCTION public.correct_trip_stage(p_trip uuid, p_stage text, p_time timestamptz, p_reason text) RETURNS timestamptz
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
       v_role IN ('owner', 'app_admin', 'plant')
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
REVOKE EXECUTE ON FUNCTION public.correct_trip_stage(uuid, text, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correct_trip_stage(uuid, text, timestamptz, text) TO belgobeton_app;
--> statement-breakpoint

-- 11. What both screens read: the stages of the rotations of a day the caller may see (a driver his own, a plant manager his plant's, owner and
--     app_admin all). Who is a role (`source`), never a name. A row written before this migration has no actor_role: its source is read from the
--     author's role.
CREATE FUNCTION public.trip_stages(p_date date) RETURNS TABLE(
  trip_id uuid, step text, at timestamptz, source text, implicit boolean, client_time timestamptz, corrected_at timestamptz, load_linked boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id(); v_role text := ctx.actor_role();
BEGIN
  IF v_driver IS NULL AND v_role IS DISTINCT FROM 'plant_manager' AND v_role IS DISTINCT FROM 'plant'
     AND v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'app_admin' THEN
    RAISE EXCEPTION 'trip_stages: role % may not read the stages of rotations', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT e.trip_id, e.step, e.at,
         CASE WHEN e.actor_role IS NOT NULL THEN e.source
              WHEN u.role = 'driver' THEN 'driver'
              WHEN u.role IN ('owner', 'app_admin') THEN 'admin'
              ELSE 'plant' END,
         e.implicit, e.client_time,
         (SELECT c.corrected_at FROM public.trip_event_correction c WHERE c.trip_id = e.trip_id AND c.step = e.step
           ORDER BY c.created_at DESC, c.id DESC LIMIT 1),
         e.delivery_id IS NOT NULL
    FROM public.trip_event e
    JOIN public.trip_plan p ON p.id = e.trip_id
    LEFT JOIN public."user" u ON u.id = e.created_by::text
   WHERE p.trip_date = p_date
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
     AND ((v_driver IS NOT NULL AND p.driver_id = v_driver)
          OR (v_driver IS NULL AND v_role IN ('owner', 'app_admin', 'plant'))
          OR (v_driver IS NULL AND v_role = 'plant_manager' AND p.plant_id IS NOT NULL AND p.plant_id = ctx.plant_scope()))
   ORDER BY e.trip_id, e.at, e.created_at;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_stages(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.trip_stages(date) TO belgobeton_app;
--> statement-breakpoint

-- 12. The timing read model keeps reading "loading began" from the driver's report projection: the stage row of the same name must not be counted twice.
CREATE OR REPLACE FUNCTION public.trip_timing(p_date date) RETURNS TABLE(
  trip_id uuid, seq integer, order_code text, plant_id uuid, truck_id uuid, truck_code text, driver_id uuid, driver_name text,
  zone_id uuid, zone_name text, one_way_min integer, load_min integer, depart_min integer, arrive_min integer,
  unload_end_min integer, back_min integer, steps json)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id(); v_role text := ctx.actor_role();
BEGIN
  IF v_driver IS NULL AND v_role IS DISTINCT FROM 'plant_manager' AND v_role IS DISTINCT FROM 'owner'
     AND v_role IS DISTINCT FROM 'app_admin' THEN
    RAISE EXCEPTION 'trip_timing: role % may not read the timing of rotations', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT p.id, p.seq, o.code, p.plant_id, p.truck_id, k.code, p.driver_id, d.name, o.zone_id, z.name, z.one_way_min,
         p.load_min, p.depart_min, p.arrive_min, p.unload_end_min, p.back_min,
         coalesce((SELECT json_agg(json_build_object('step', s.step, 'at', s.at) ORDER BY s.at) FROM (
            -- the time of a tap for the delay figures: a correction's, else the phone's own time (an offline tap), else the server's
            SELECT e.step, coalesce((SELECT c.corrected_at FROM public.trip_event_correction c WHERE c.trip_id = e.trip_id AND c.step = e.step
                                      ORDER BY c.created_at DESC, c.id DESC LIMIT 1), e.client_time, e.at) AS at
              FROM public.trip_event e WHERE e.trip_id = p.id AND e.step <> 'loading_started'
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
