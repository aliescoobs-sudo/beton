-- T9b (docs/T9-TRIP-SHARED-STATUS.md, decision 206 option B1): TWO marks. The driver's unloading_finished is the operational "delivered" (a stage row, shown
-- as "declared by the driver"); the BILLING GATE (`delivery_delivered`) is set only by the plant side. Adds: the plant's confirmation of the stages it is the
-- authority for (departed, back), the automatic gate when the plant confirms the truck's RETURN for a declared unloading, the exception lists, and the
-- company phone for the driver's tel: link. Forward only.

-- 1. The gate says how it was set (the audit log keeps the actor; this keeps the way).
ALTER TABLE public.delivery_delivered ADD COLUMN via text NOT NULL DEFAULT 'plant_stage' CHECK (via IN ('plant_stage', 'return', 'confirm', 'hand'));
--> statement-breakpoint

-- 2. The plant's confirmation of a stage it is the authority for (departed, back) that the driver declared: a new row, the plant's own instant.
CREATE TABLE public.trip_event_confirmation (
  id           uuid PRIMARY KEY,
  trip_id      uuid NOT NULL,
  step         text NOT NULL CHECK (step IN ('departed', 'back')),
  confirmed_at timestamptz NOT NULL,
  actor_id     uuid NOT NULL,
  actor_role   text NOT NULL CHECK (actor_role IN ('plant', 'plant_manager', 'owner', 'app_admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, step),
  FOREIGN KEY (trip_id, step) REFERENCES public.trip_event (trip_id, step)
);
--> statement-breakpoint
ALTER TABLE public.trip_event_confirmation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trip_event_confirmation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.trip_event_confirmation FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.trip_event_confirmation TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY trip_event_confirmation_read ON public.trip_event_confirmation FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'plant')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = trip_event_confirmation.trip_id AND p.plant_id = ctx.plant_scope())));
--> statement-breakpoint
CREATE POLICY trip_event_confirmation_definer ON public.trip_event_confirmation FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER trip_event_confirmation_append_only BEFORE UPDATE OR DELETE ON public.trip_event_confirmation
  FOR EACH ROW EXECUTE FUNCTION public._forbid_change();
--> statement-breakpoint
SELECT audit.attach('public.trip_event_confirmation');
--> statement-breakpoint

-- 3. The billing gate set by the RETURN: the plant confirms the truck is back (its own tap, or its confirmation of the driver's) for a rotation whose unloading
--    was declared finished (not filled in) and whose plant load exists: the gate is set in the same transaction, once, by that plant user (audited).
CREATE FUNCTION public._gate_on_return(p_trip uuid, p_actor uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_fin  public.trip_event%ROWTYPE;
  v_load public.trip_event%ROWTYPE;
BEGIN
  SELECT * INTO v_fin FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'unloading_finished';
  IF NOT FOUND OR v_fin.implicit THEN RETURN false; END IF;
  SELECT * INTO v_load FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'loaded';
  IF NOT FOUND OR v_load.delivery_id IS NULL THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_delivered d WHERE d.delivery_id = v_load.delivery_id) THEN RETURN false; END IF;
  INSERT INTO public.delivery_delivered (id, delivery_id, at, trip_event_id, created_by, via)
  VALUES (gen_random_uuid(), v_load.delivery_id, v_fin.at, v_fin.id, p_actor, 'return');
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._gate_on_return(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.trip_event_return_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._gate_on_return(NEW.trip_id, NEW.created_by);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_event_return_gate AFTER INSERT ON public.trip_event
  FOR EACH ROW WHEN (NEW.step = 'back' AND NOT NEW.implicit AND NEW.source IN ('plant', 'admin')) EXECUTE FUNCTION public.trip_event_return_gate();
--> statement-breakpoint
CREATE FUNCTION public.trip_confirmation_return_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._gate_on_return(NEW.trip_id, NEW.actor_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_confirmation_return_gate AFTER INSERT ON public.trip_event_confirmation
  FOR EACH ROW WHEN (NEW.step = 'back') EXECUTE FUNCTION public.trip_confirmation_return_gate();
--> statement-breakpoint

-- 4. The explicit confirmation of the delivery (a truck that does not come back, owner / app_admin): same as 0209, and it says how.
CREATE OR REPLACE FUNCTION public.confirm_trip_delivered(p_trip uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.actor_role();
  v_trip public.trip_plan%ROWTYPE;
  v_fin  public.trip_event%ROWTYPE;
  v_load public.trip_event%ROWTYPE;
BEGIN
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;
  IF NOT FOUND OR ctx.driver_id() IS NOT NULL OR NOT (
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
  INSERT INTO public.delivery_delivered (id, delivery_id, at, trip_event_id, created_by, via)
  VALUES (gen_random_uuid(), v_load.delivery_id, v_fin.at, v_fin.id, ctx.user_id(), 'confirm');
  RETURN true;
END $$;
--> statement-breakpoint

-- 5. The plant confirms a stage it is the authority for (departed, back) that the driver declared. Its own instant is the one the figures and alerts use.
--    Idempotent; a stage the plant or an administrator recorded needs none.
CREATE FUNCTION public.confirm_trip_stage(p_trip uuid, p_stage text, p_now timestamptz) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.actor_role();
  v_trip public.trip_plan%ROWTYPE;
  v_row  public.trip_event%ROWTYPE;
BEGIN
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;
  IF NOT FOUND OR ctx.user_id() IS NULL OR ctx.driver_id() IS NOT NULL OR p_now IS NULL OR NOT (
       v_role IN ('owner', 'app_admin', 'plant')
       OR (v_role = 'plant_manager' AND v_trip.plant_id IS NOT NULL AND v_trip.plant_id = ctx.plant_scope())) THEN
    RAISE EXCEPTION 'confirm_trip_stage: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_stage NOT IN ('departed', 'back') THEN
    RAISE EXCEPTION 'confirm_trip_stage: the plant is not the authority for this stage' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || p_trip::text, 0));
  SELECT * INTO v_row FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = p_stage;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirm_trip_stage: the stage is not recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.source <> 'driver' OR v_row.implicit OR EXISTS (SELECT 1 FROM public.trip_event_confirmation c WHERE c.trip_id = p_trip AND c.step = p_stage) THEN
    RETURN false;
  END IF;
  INSERT INTO public.trip_event_confirmation (id, trip_id, step, confirmed_at, actor_id, actor_role)
  VALUES (gen_random_uuid(), p_trip, p_stage, greatest(p_now, v_row.at), ctx.user_id(), v_role);
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.confirm_trip_stage(uuid, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.confirm_trip_stage(uuid, text, timestamptz) TO belgobeton_app;
--> statement-breakpoint

-- 6. trip_stages with the plant's confirmation.
DROP FUNCTION public.trip_stages(date);
--> statement-breakpoint
CREATE FUNCTION public.trip_stages(p_date date) RETURNS TABLE(
  trip_id uuid, step text, at timestamptz, source text, implicit boolean, client_time timestamptz, corrected_at timestamptz, load_linked boolean,
  confirmed_at timestamptz)
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
         e.delivery_id IS NOT NULL,
         (SELECT f.confirmed_at FROM public.trip_event_confirmation f WHERE f.trip_id = e.trip_id AND f.step = e.step)
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

-- 7. The exception lists. Flag only, never corrected: (declared_no_record) the driver declared the delivery and the plant has no load of it;
--    (unconfirmed) the unloading was declared and the plant's load is not yet through the billing gate after the end of the working day (+ the
--    configurable delay `delivery_confirm_delay_min`, default 0); (volume_differs) the plant's load differs from the planned volume of the rotation or
--    from what the driver declared; (order_differs) every rotation of an order has finished unloading and the plant's loads do not add up to the order.
--    Scoped as trip_stages: a plant manager sees his plant's rotations only; owner, app_admin and the unbound plant account see all; a driver reads none.
CREATE FUNCTION public.trip_delivery_exceptions(p_from date, p_to date) RETURNS TABLE(
  kind text, trip_id uuid, trip_date date, order_code text, truck_code text, plant_volume_l integer, planned_volume_l integer,
  declared_volume_l integer, order_volume_l integer, due_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text := ctx.actor_role();
  v_start integer := coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'day_start_min'), 420);
  v_work  integer := coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'working_min'), 600);
  v_delay integer := coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'delivery_confirm_delay_min'), 0);
BEGIN
  IF ctx.driver_id() IS NOT NULL OR v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'app_admin'
     AND v_role IS DISTINCT FROM 'plant' AND v_role IS DISTINCT FROM 'plant_manager' THEN
    RAISE EXCEPTION 'trip_delivery_exceptions: role % may not read the exceptions', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  WITH t AS (
    SELECT p.id AS tid, p.trip_date AS tdate, p.order_id, p.volume_l AS planned, o.code AS ocode, k.code AS kcode, o.volume_l AS ovol,
           (fin.id IS NOT NULL AND NOT fin.implicit) AS declared_fin, fin.source AS fin_source,
           l.delivery_id, d.volume_l AS pvol,
           (SELECT r.volume_l FROM public.trip_driver_report r WHERE r.trip_id = p.id AND r.kind = 'unloaded') AS dvol,
           EXISTS (SELECT 1 FROM public.delivery_delivered g WHERE g.delivery_id = l.delivery_id) AS gated,
           ((p.trip_date::timestamp + make_interval(mins => v_start + v_work + v_delay)) AT TIME ZONE 'Africa/Casablanca') AS due
      FROM public.trip_plan p
      JOIN public.sales_order o ON o.id = p.order_id
      JOIN public.truck k ON k.id = p.truck_id
      LEFT JOIN public.trip_event fin ON fin.trip_id = p.id AND fin.step = 'unloading_finished'
      LEFT JOIN public.trip_event l ON l.trip_id = p.id AND l.step = 'loaded'
      LEFT JOIN public.delivery d ON d.id = l.delivery_id
     WHERE p.trip_date BETWEEN p_from AND p_to
       AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
       AND (v_role IN ('owner', 'app_admin', 'plant')
            OR (v_role = 'plant_manager' AND p.plant_id IS NOT NULL AND p.plant_id = ctx.plant_scope())))
  SELECT 'declared_no_record', t.tid, t.tdate, t.ocode, t.kcode, NULL::integer, t.planned, t.dvol, t.ovol, NULL::timestamptz
    FROM t WHERE t.declared_fin AND t.fin_source = 'driver' AND t.delivery_id IS NULL
  UNION ALL
  SELECT 'unconfirmed', t.tid, t.tdate, t.ocode, t.kcode, t.pvol, t.planned, t.dvol, t.ovol, t.due
    FROM t WHERE t.declared_fin AND t.delivery_id IS NOT NULL AND NOT t.gated AND now() > t.due
  UNION ALL
  SELECT 'volume_differs', t.tid, t.tdate, t.ocode, t.kcode, t.pvol, t.planned, t.dvol, t.ovol, NULL::timestamptz
    FROM t WHERE t.delivery_id IS NOT NULL AND (t.pvol <> t.planned OR (t.dvol IS NOT NULL AND t.pvol <> t.dvol))
  UNION ALL
  (SELECT DISTINCT ON (t.order_id) 'order_differs', t.tid, t.tdate, t.ocode, t.kcode,
         (SELECT coalesce(sum(d2.volume_l), 0)::integer FROM public.delivery d2
           WHERE d2.order_id = t.order_id AND d2.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d2.id)),
         t.planned, t.dvol, t.ovol, NULL::timestamptz
    FROM t
   WHERE t.declared_fin
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan q
                      WHERE q.order_id = t.order_id AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = q.id)
                        AND NOT EXISTS (SELECT 1 FROM public.trip_event f WHERE f.trip_id = q.id AND f.step = 'unloading_finished'))
     AND t.ovol <> (SELECT coalesce(sum(d2.volume_l), 0) FROM public.delivery d2
                     WHERE d2.order_id = t.order_id AND d2.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d2.id))
   ORDER BY t.order_id, t.tdate DESC);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_delivery_exceptions(date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.trip_delivery_exceptions(date, date) TO belgobeton_app;
--> statement-breakpoint

-- 8. The office number the driver may call: the phone of the company profile in force (the only phone setting there is). Nothing else of the profile.
CREATE FUNCTION public.company_contact_phone() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role();
BEGIN
  IF ctx.driver_id() IS NULL AND v_role IS DISTINCT FROM 'owner' AND v_role IS DISTINCT FROM 'app_admin'
     AND v_role IS DISTINCT FROM 'plant' AND v_role IS DISTINCT FROM 'plant_manager' THEN
    RAISE EXCEPTION 'company_contact_phone: role % may not read it', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT nullif(btrim(c.phone), '') FROM public.company_profile c WHERE c.effective_from <= current_date
           ORDER BY c.effective_from DESC, c.created_at DESC LIMIT 1);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.company_contact_phone() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.company_contact_phone() TO belgobeton_app;
--> statement-breakpoint

-- 9. The timing read model: the plant's confirmation is the time of departed / back for the figures and alerts.
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
            -- the time of a tap for the figures and alerts: a correction's, else the plant's confirmation (it is the authority for departed / back), else the phone's own time (an offline tap), else the server's
            SELECT e.step, coalesce((SELECT c.corrected_at FROM public.trip_event_correction c WHERE c.trip_id = e.trip_id AND c.step = e.step
                                      ORDER BY c.created_at DESC, c.id DESC LIMIT 1),
                                    (SELECT f.confirmed_at FROM public.trip_event_confirmation f WHERE f.trip_id = e.trip_id AND f.step = e.step),
                                    e.client_time, e.at) AS at
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
