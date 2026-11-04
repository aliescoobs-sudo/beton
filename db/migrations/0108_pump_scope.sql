-- D1 / F01 (CODEX-REVIEW-FINAL): the pump surface leaked across plants. A plant manager (bound to a plant) read every plant's pump jobs
-- with client names, site labels and order codes, and could move or mark any plant's jobs and orders. The scope is now the database's:
-- a pump job carries its plant (the plant of its order, else the plant of the one who scheduled it), and every read and every write of
-- the pump surface, the emergency instructions and the redirect candidates checks it. A NULL plant is visible only to roles that are
-- not bound to a plant (no guess, no "unknown means shared": these rows name clients and sites).
ALTER TABLE public.pump_job ADD COLUMN plant_id uuid REFERENCES public.plant (id);
--> statement-breakpoint
CREATE FUNCTION public._pump_in_scope(p_plant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ctx.plant_scope() IS NULL OR p_plant = ctx.plant_scope()
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._pump_in_scope(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public._pump_in_scope(uuid) TO belgobeton_app, belgobeton_migrator;
--> statement-breakpoint
-- Every insert of a pump job (the old door and the new one) takes the plant of its order, else of the request's scope; a manager cannot
-- schedule a job of another plant's order.
CREATE FUNCTION public.pump_job_plant_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_order_plant uuid;
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    SELECT o.plant_id INTO v_order_plant FROM public.sales_order o WHERE o.id = NEW.order_id;
    NEW.plant_id := v_order_plant;
  ELSE
    NEW.plant_id := coalesce(NEW.plant_id, ctx.plant_scope());
  END IF;
  IF NOT public._pump_in_scope(NEW.plant_id) THEN
    RAISE EXCEPTION 'pump: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_pump_job_plant_guard BEFORE INSERT ON public.pump_job FOR EACH ROW EXECUTE FUNCTION public.pump_job_plant_guard();
--> statement-breakpoint
-- Direct reads of the pump tables follow the same scope (the application role can select them).
DROP POLICY pump_job_read ON public.pump_job;
--> statement-breakpoint
CREATE POLICY pump_job_read ON public.pump_job FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant') AND (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
DROP POLICY pump_job_event_read ON public.pump_job_event;
--> statement-breakpoint
CREATE POLICY pump_job_event_read ON public.pump_job_event FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant')
         AND EXISTS (SELECT 1 FROM public.pump_job j WHERE j.id = job_id AND (ctx.plant_scope() IS NULL OR j.plant_id = ctx.plant_scope())));
--> statement-breakpoint
DROP POLICY order_pump_read ON public.order_pump;
--> statement-breakpoint
CREATE POLICY order_pump_read ON public.order_pump FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.sales_order o WHERE o.id = order_id AND o.plant_id = ctx.plant_scope())));
--> statement-breakpoint
DROP POLICY pump_conflict_read ON public.pump_conflict;
--> statement-breakpoint
CREATE POLICY pump_conflict_read ON public.pump_conflict FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.pump_job j WHERE j.id = job_id AND j.plant_id = ctx.plant_scope())));
--> statement-breakpoint
-- The same for the driver reports, emergencies and instructions of a rotation: read through the plant of the rotation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_driver_report', 'trip_emergency', 'trip_instruction'] LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() IN (''owner'', ''partner'', ''office'', ''plant'') AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = trip_id AND p.plant_id = ctx.plant_scope())))',
      t || '_read', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.set_order_pumped(p_order uuid, p_pumped boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._pump_actor_check();
  IF NOT EXISTS (SELECT 1 FROM public.sales_order o WHERE o.id = p_order AND o.reverses_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)) THEN
    RAISE EXCEPTION 'pump: not a live order' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public._pump_in_scope((SELECT o.plant_id FROM public.sales_order o WHERE o.id = p_order)) THEN
    RAISE EXCEPTION 'pump: another plant' USING ERRCODE = 'insufficient_privilege';
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
CREATE OR REPLACE FUNCTION public.set_order_pumped_by_code(p_code text, p_pumped boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public._pump_actor_check();
  SELECT o.id INTO v_id FROM public.sales_order o WHERE o.code = upper(btrim(p_code)) AND o.reverses_id IS NULL AND public._pump_in_scope(o.plant_id);
  IF v_id IS NULL THEN RAISE EXCEPTION 'pump: not a live order' USING ERRCODE = 'check_violation'; END IF;
  RETURN public.set_order_pumped(v_id, p_pumped);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.reschedule_pump_job(p_job uuid, p_on_site_min integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._pump_actor_check();
  IF p_on_site_min IS NULL OR p_on_site_min NOT BETWEEN 0 AND 1439 THEN
    RAISE EXCEPTION 'pump: the time on site is invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pump_job j WHERE j.id = p_job AND public._pump_in_scope(j.plant_id)) THEN
    RAISE EXCEPTION 'pump: unknown pump job' USING ERRCODE = 'check_violation';
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
CREATE OR REPLACE FUNCTION public.resolve_pump_conflict(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._pump_actor_check();
  UPDATE public.pump_conflict SET resolved_at = now(), resolved_by = ctx.user_id() WHERE id = p_id AND resolved_at IS NULL
     AND EXISTS (SELECT 1 FROM public.pump_job j WHERE j.id = job_id AND public._pump_in_scope(j.plant_id));
  RETURN FOUND;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.pump_board(p_date date) RETURNS TABLE(
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
     WHERE j.job_date = p_date AND (ctx.plant_scope() IS NULL OR j.plant_id = ctx.plant_scope())
     ORDER BY j.on_site_min NULLS LAST, k.code;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.pump_waiting(p_date date) RETURNS TABLE(order_id uuid, order_code text, client_name text, volume_l integer)
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
       AND (ctx.plant_scope() IS NULL OR o.plant_id = ctx.plant_scope())
     ORDER BY o.code;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.pump_conflicts(p_date date) RETURNS TABLE(
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
     WHERE f.job_date = p_date AND (ctx.plant_scope() IS NULL OR j.plant_id = ctx.plant_scope())
     ORDER BY f.resolved_at IS NOT NULL, f.created_at;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.emergency_instruct(p_emergency uuid, p_kind text, p_address_enc text, p_map_url text, p_note text, p_join_trip uuid) RETURNS uuid
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
  IF NOT public._pump_in_scope((SELECT p.plant_id FROM public.trip_plan p WHERE p.id = v_trip)) THEN
    RAISE EXCEPTION 'emergency_instruct: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.trip_instruction (id, emergency_id, trip_id, kind, address_enc, map_url, note, join_trip_id, created_by)
  VALUES (v_id, p_emergency, v_trip, p_kind, p_address_enc, p_map_url, nullif(btrim(p_note), ''), p_join_trip, ctx.user_id());
  UPDATE public.trip_emergency SET resolved_at = coalesce(resolved_at, now()) WHERE id = p_emergency;
  RETURN v_id;
END $$;
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
     ORDER BY o.code;
END $$;
