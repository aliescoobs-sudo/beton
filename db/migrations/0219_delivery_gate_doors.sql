-- R18-07: the billing gate (delivery_delivered) was writable and readable outside the plant boundary. The application login had INSERT with an unscoped `plant`
-- admission, the guard checked the load and the event relationship but not the plant, the source or an explicit finish, and the read policy was unscoped, so a plant
-- manager with app-login SQL could read B / plantless gate and event references, mark an unlinked foreign load by id, or insert a gate using a real driver unloading
-- event before the plant confirmed it. The confirm door also accepted an implicit (filled-in) finish while the return gate required an explicit one. Now:
--   1. No application INSERT at all. The gate is written only by definer code: the plant's own unloading stage (trip_event_delivered), the plant's confirmation of
--      the return (_gate_on_return), and two scoped DOORS: confirm_trip_delivered (a rotation) and mark_load_delivered (a load outside any rotation).
--   2. Read is scoped through the load (RLS of the delivery applies: a plant manager reads gates of his plant's loads only).
--   3. The guard trigger checks the PLANT (a scoped actor reaches only his plant's loads), the SOURCE and the STAGE per way: 'plant_stage' needs an explicit unloading
--      stage recorded by the plant side (not the driver, not filled in); 'return' and 'confirm' need an explicit finish (declared or recorded, never implicit); 'hand'
--      needs no rotation event. Both doors need an explicit finish where a rotation exists, and a load of the rotation's own plant.
--   4. attach_trip_load links only a load of the same order and plant as the rotation.
-- Forward migration.
DROP POLICY delivery_delivered_insert ON public.delivery_delivered;
--> statement-breakpoint
REVOKE INSERT ON public.delivery_delivered FROM belgobeton_app;
--> statement-breakpoint
DROP POLICY delivery_delivered_read ON public.delivery_delivered;
--> statement-breakpoint
CREATE POLICY delivery_delivered_read ON public.delivery_delivered FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant')
         AND (ctx.plant_scope() IS NULL
              OR EXISTS (SELECT 1 FROM public.delivery d WHERE d.id = delivery_delivered.delivery_id AND d.plant_id = ctx.plant_scope())));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.delivery_delivered_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.delivery%ROWTYPE;
  v_e public.trip_event%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM public.delivery WHERE id = NEW.delivery_id;
  -- a scoped actor reaches only the loads of his plant; absent and foreign are one answer
  IF NOT FOUND OR (ctx.plant_scope() IS NOT NULL AND v_d.plant_id IS DISTINCT FROM ctx.plant_scope()) THEN
    RAISE EXCEPTION 'delivery_delivered: not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery c WHERE c.reverses_id = v_d.id) THEN
    RAISE EXCEPTION 'delivery_delivered: not a live load' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.via = 'hand' THEN
    IF NEW.trip_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'delivery_delivered: a load marked by hand has no rotation step' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.trip_event e WHERE e.delivery_id = NEW.delivery_id) THEN
      RAISE EXCEPTION 'delivery_delivered: this load follows its rotation' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.trip_event_id IS NULL THEN
      RAISE EXCEPTION 'delivery_delivered: a rotation load needs its unloading step' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_e FROM public.trip_event WHERE id = NEW.trip_event_id;
    IF NOT FOUND OR v_e.step <> 'unloading_finished' OR NEW.at <> v_e.at OR NOT EXISTS (
         SELECT 1 FROM public.trip_event l
          WHERE l.trip_id = v_e.trip_id AND l.step = 'loaded' AND l.delivery_id = NEW.delivery_id) THEN
      RAISE EXCEPTION 'delivery_delivered: not the unloading step of this load' USING ERRCODE = 'check_violation';
    END IF;
    -- an explicit finish only: a stage filled in because a later one was recorded is not an unloading anybody declared
    IF v_e.implicit THEN
      RAISE EXCEPTION 'delivery_delivered: the unloading was filled in, not declared' USING ERRCODE = 'check_violation';
    END IF;
    -- the plant's own stage opens the gate by itself; a stage the DRIVER declared opens it only through the plant's confirmation (return or confirm)
    IF NEW.via = 'plant_stage' AND v_e.source NOT IN ('plant', 'admin') THEN
      RAISE EXCEPTION 'delivery_delivered: a driver''s declaration is not the plant''s' USING ERRCODE = 'check_violation';
    END IF;
    -- the rotation, the load and the gate are of one plant
    IF NOT EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = v_e.trip_id AND p.plant_id IS NOT DISTINCT FROM v_d.plant_id) THEN
      RAISE EXCEPTION 'delivery_delivered: the load is not of the rotation''s plant' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- The door for a load outside any rotation (was a direct INSERT by the application login).
CREATE FUNCTION public.mark_load_delivered(p_delivery uuid, p_now timestamptz) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d  public.delivery%ROWTYPE;
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM ctx.require_actor('mark_load_delivered', ARRAY['owner', 'app_admin', 'plant', 'plant_manager']);
  SELECT * INTO v_d FROM public.delivery WHERE id = p_delivery;
  IF NOT FOUND OR ctx.in_actor_scope(ARRAY['owner', 'app_admin', 'plant'], v_d.plant_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'mark_load_delivered: not your load' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > coalesce(ctx.sim_now(), now()) + interval '5 minutes' THEN
    RAISE EXCEPTION 'mark_load_delivered: the instant is not now' USING ERRCODE = 'check_violation';
  END IF;
  -- a load that belongs to a rotation follows its rotation (said before "already delivered", as the guard always did)
  IF EXISTS (SELECT 1 FROM public.trip_event e WHERE e.delivery_id = p_delivery) THEN
    RAISE EXCEPTION 'delivery_delivered: this load follows its rotation' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_delivered g WHERE g.delivery_id = p_delivery) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.delivery_delivered (id, delivery_id, at, trip_event_id, created_by, via)
  VALUES (v_id, p_delivery, p_now, NULL, ctx.user_id(), 'hand');
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mark_load_delivered(uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_load_delivered(uuid, timestamptz) TO belgobeton_app;
--> statement-breakpoint

-- The door for a rotation's delivery (a truck that does not come back): an EXPLICIT finish (never a filled-in one) and a load of the rotation's plant.
CREATE OR REPLACE FUNCTION public.confirm_trip_delivered(p_trip uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.actor_role();
  v_trip public.trip_plan%ROWTYPE;
  v_fin  public.trip_event%ROWTYPE;
  v_load public.trip_event%ROWTYPE;
  v_d    public.delivery%ROWTYPE;
BEGIN
  PERFORM ctx.require_actor('confirm_trip_delivered', ARRAY['owner', 'app_admin', 'plant', 'plant_manager']);
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;
  IF NOT FOUND OR ctx.in_actor_scope(ARRAY['owner', 'app_admin', 'plant'], v_trip.plant_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'confirm_trip_delivered: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || p_trip::text, 0));
  SELECT * INTO v_fin FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'unloading_finished';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirm_trip_delivered: the unloading is not finished' USING ERRCODE = 'check_violation';
  END IF;
  IF v_fin.implicit THEN
    RAISE EXCEPTION 'confirm_trip_delivered: the unloading was filled in, not declared' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_load FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'loaded';
  IF NOT FOUND OR v_load.delivery_id IS NULL THEN
    RAISE EXCEPTION 'confirm_trip_delivered: the plant''s load is not recorded' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_d FROM public.delivery WHERE id = v_load.delivery_id;
  IF NOT FOUND OR v_d.plant_id IS DISTINCT FROM v_trip.plant_id THEN
    RAISE EXCEPTION 'confirm_trip_delivered: the load is not of the rotation''s plant' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_delivered d WHERE d.delivery_id = v_load.delivery_id) THEN
    RETURN false;
  END IF;
  INSERT INTO public.delivery_delivered (id, delivery_id, at, trip_event_id, created_by, via)
  VALUES (gen_random_uuid(), v_load.delivery_id, v_fin.at, v_fin.id, ctx.user_id(), 'confirm');
  RETURN true;
END $$;
--> statement-breakpoint

-- The plant's load linked to a stage the driver declared: the load is of THIS rotation's order and plant.
CREATE OR REPLACE FUNCTION public.attach_trip_load(p_trip uuid, p_delivery uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.actor_role();
  v_trip public.trip_plan%ROWTYPE;
BEGIN
  PERFORM ctx.require_actor('attach_trip_load', ARRAY['owner', 'app_admin', 'plant', 'plant_manager']);
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;
  IF NOT FOUND OR ctx.in_actor_scope(ARRAY['owner', 'app_admin', 'plant'], v_trip.plant_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'attach_trip_load: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.delivery d WHERE d.id = p_delivery AND d.order_id = v_trip.order_id
                    AND d.plant_id IS NOT DISTINCT FROM v_trip.plant_id) THEN
    RAISE EXCEPTION 'attach_trip_load: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || p_trip::text, 0));
  UPDATE public.trip_event e SET delivery_id = p_delivery WHERE e.trip_id = p_trip AND e.step = 'loaded' AND e.delivery_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attach_trip_load: no declared loaded stage without a load' USING ERRCODE = 'check_violation';
  END IF;
END $$;
