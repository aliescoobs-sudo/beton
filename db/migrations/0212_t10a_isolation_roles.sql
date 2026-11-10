-- T10a (R17-02, R17-03, R17-04; decision 207). Forward migration; nothing applied is edited.
--   1. A trip, plan or order with NO plant is for the owner, the app_admin and the office dispatch roles; never for a plant manager.
--   2. A plant manager reads only the drivers assigned to his plant (default driver of one of his trucks) or with a trip at his plant.
--   3. Cancellations of a rotation are read and written through the rotation's plant; forbidden and non-existent give ONE answer.
--   4. Reserved roles (partner, support): no session, no re-activation; the migration is an admission check.
--   5. NULL-role class: answer_survey, order_timeline, cancellation_trip_stage, send_test_notification, log_dispatch_change.

-- 1. The scope predicate no longer lets a NULL plant through (NOT NULL is NULL, so `IF NOT _pump_in_scope(NULL)` never raised).
CREATE OR REPLACE FUNCTION public._pump_in_scope(p_plant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ctx.plant_scope() IS NULL OR coalesce(p_plant = ctx.plant_scope(), false)
$$;
--> statement-breakpoint
DROP POLICY plant_scope ON public.trip_plan;
--> statement-breakpoint
CREATE POLICY plant_scope ON public.trip_plan AS RESTRICTIVE FOR ALL TO belgobeton_app
  USING (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope())
  WITH CHECK (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope());
--> statement-breakpoint
DROP POLICY plant_scope ON public.sales_order;
--> statement-breakpoint
CREATE POLICY plant_scope ON public.sales_order AS RESTRICTIVE FOR ALL TO belgobeton_app
  USING (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope())
  WITH CHECK (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope());
--> statement-breakpoint
CREATE OR REPLACE VIEW public.sales_order_ops WITH (security_barrier = true) AS
 SELECT o.id, o.code, o.concrete_type_id, o.volume_l, o.delivery_date, o.zone_id, o.site_id, c.code AS client_code,
    s.label AS site_label, o.reverses_id,
    (EXISTS ( SELECT 1 FROM public.sales_order r WHERE (r.reverses_id = o.id))) AS is_reversed,
    o.plant_id
   FROM ((public.sales_order o
     JOIN public.client c ON ((c.id = o.client_id)))
     LEFT JOIN public.client_site s ON ((s.id = o.site_id)))
  WHERE ctx.role() = ANY (ARRAY['owner'::text, 'support'::text, 'partner'::text, 'plant'::text])
    AND (ctx.plant_scope() IS NULL OR o.plant_id = ctx.plant_scope());
--> statement-breakpoint

-- 2. The drivers a plant manager may know of. SECURITY DEFINER so the policy needs no read right on the tables it looks at.
CREATE FUNCTION public.driver_in_plant_scope(p_driver uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(ctx.actor_role(), '') IN ('owner', 'app_admin', 'partner', 'plant_manager', 'plant')
     AND (ctx.plant_scope() IS NULL
      OR EXISTS (SELECT 1 FROM public.truck t WHERE t.default_driver_id = p_driver AND t.plant_id = ctx.plant_scope())
      OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.driver_id = p_driver AND p.plant_id = ctx.plant_scope()))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.driver_in_plant_scope(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.driver_in_plant_scope(uuid) TO belgobeton_app;
--> statement-breakpoint
DROP POLICY driver_read ON public.driver;
--> statement-breakpoint
CREATE POLICY driver_read ON public.driver FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant') AND public.driver_in_plant_scope(id));
--> statement-breakpoint
DROP POLICY trip_plan_insert ON public.trip_plan;
--> statement-breakpoint
CREATE POLICY trip_plan_insert ON public.trip_plan FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND created_by = ctx.user_id()
              AND (driver_id IS NULL OR public.driver_in_plant_scope(driver_id)));
--> statement-breakpoint

-- 3. Cancellations: through the rotation's plant (owner and app_admin: all). The BEFORE INSERT guard answers a rotation that does not exist
--    and a rotation of another plant with the same error, BEFORE it looks at whether the rotation has started (no start oracle).
DROP POLICY trip_plan_cancellation_read ON public.trip_plan_cancellation;
--> statement-breakpoint
CREATE POLICY trip_plan_cancellation_read ON public.trip_plan_cancellation FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = trip_plan_cancellation.trip_id AND p.plant_id = ctx.plant_scope())));
--> statement-breakpoint
DROP POLICY trip_plan_cancellation_insert ON public.trip_plan_cancellation;
--> statement-breakpoint
CREATE POLICY trip_plan_cancellation_insert ON public.trip_plan_cancellation FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND created_by = ctx.user_id()
              AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = trip_plan_cancellation.trip_id AND p.plant_id = ctx.plant_scope())));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.trip_plan_cancellation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_date date; v_plant uuid; v_found boolean; v_role text := ctx.actor_role();
BEGIN
  SELECT p.trip_date, p.plant_id, true INTO v_date, v_plant, v_found FROM public.trip_plan p WHERE p.id = NEW.trip_id;
  -- one answer for "no such rotation" and "not yours" (and for an actor who may not cancel at all)
  IF v_role IS NULL OR coalesce(v_role, '') NOT IN ('owner', 'app_admin', 'office', 'office_sales', 'partner', 'plant_manager', 'plant', 'system')
     OR v_found IS NOT TRUE
     OR (v_role = 'plant_manager' AND v_plant IS DISTINCT FROM ctx.plant_scope()) THEN
    RAISE EXCEPTION 'trip_plan_cancellation: no such rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_plan_day:' || v_date::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || NEW.trip_id::text, 0));
  IF public.trip_started_internal(NEW.trip_id) THEN
    RAISE EXCEPTION 'trip_plan: a rotation that has started cannot be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 4. Reserved roles. Existing rows too: no session, no re-activation (this guard fires on the status as well as on the role).
CREATE OR REPLACE FUNCTION public.user_reserved_role_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.role IN ('partner', 'support')
     AND (TG_OP = 'INSERT' OR NEW.role IS DISTINCT FROM OLD.role OR (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active'))
     AND session_user NOT IN ('belgobeton_migrator') AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user) THEN
    RAISE EXCEPTION 'user: the role % has no accounts in V1', NEW.role USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER user_reserved_role_guard ON public."user";
--> statement-breakpoint
CREATE TRIGGER user_reserved_role_guard BEFORE INSERT OR UPDATE OF role, status ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.user_reserved_role_guard();
--> statement-breakpoint
CREATE FUNCTION public.session_reserved_role_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."user" u WHERE u.id = NEW."userId" AND u.role IN ('partner', 'support'))
     AND session_user NOT IN ('belgobeton_migrator') AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user) THEN
    RAISE EXCEPTION 'session: the role of this account has no sessions in V1' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER session_reserved_role_guard BEFORE INSERT ON public."session"
  FOR EACH ROW EXECUTE FUNCTION public.session_reserved_role_guard();
--> statement-breakpoint
-- The admission check (migration, start, seed): every session of a reserved-role account is revoked; any such account still usable stops it.
CREATE FUNCTION public.usable_reserved_role_accounts() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*) FROM public."user" u WHERE u.role IN ('partner', 'support') AND u.status = 'active'
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.usable_reserved_role_accounts() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.usable_reserved_role_accounts() TO belgobeton_auth, belgobeton_system, belgobeton_migrator;
--> statement-breakpoint
CREATE FUNCTION public.admit_no_reserved_accounts() RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM public."session" s USING public."user" u WHERE s."userId" = u.id AND u.role IN ('partner', 'support');
  n := public.usable_reserved_role_accounts();
  IF n > 0 THEN
    RAISE EXCEPTION 'admission: % usable account(s) hold a reserved role (partner or support); disable them (or give them a V1 role) before this version starts', n
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admit_no_reserved_accounts() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admit_no_reserved_accounts() TO belgobeton_migrator;
--> statement-breakpoint
SELECT public.admit_no_reserved_accounts();
--> statement-breakpoint

-- 5. NULL-role class. A door needs a VALIDATED actor (ctx.actor_role() raises for a role that does not match the account) and compares with
--    IS DISTINCT FROM or a positive allowlist.
DO $$
DECLARE def text; fixed text;
BEGIN
  def := pg_catalog.pg_get_functiondef('public.answer_survey(uuid, jsonb)'::regprocedure);
  fixed := replace(def, 's.audience_role <> ctx.actor_role()', 'ctx.actor_role() IS NULL OR s.audience_role IS DISTINCT FROM ctx.actor_role()');
  IF fixed = def THEN RAISE EXCEPTION '0212: answer_survey was not rewritten'; END IF;
  EXECUTE fixed;
  def := pg_catalog.pg_get_functiondef('public.order_timeline(uuid)'::regprocedure);
  fixed := replace(def, $q$ctx.actor_role() IN ('driver', 'pump_operator', 'client_portal', 'supplier_portal') THEN$q$,
                   $q$coalesce(ctx.actor_role(), '') NOT IN ('owner', 'app_admin', 'accountant', 'office', 'office_sales', 'office_purchases', 'plant', 'plant_manager') THEN$q$);
  fixed := replace(fixed, $q$IN ('owner', 'app_admin', 'support', 'accountant')$q$, $q$IN ('owner', 'app_admin', 'accountant')$q$);
  IF fixed = def THEN RAISE EXCEPTION '0212: order_timeline was not rewritten'; END IF;
  EXECUTE fixed;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.send_test_notification() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.user_id() IS NULL OR coalesce(ctx.actor_role(), 'anonymous') IN ('anonymous', 'system') THEN RAISE EXCEPTION 'send_test_notification: no actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN public.notify('test', 'info', '{}', '/notifications', NULL, ARRAY[]::text[], ARRAY[ctx.user_id()]);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.cancellation_trip_stage(p_trip uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role();
BEGIN
  IF v_role IS NULL OR coalesce(v_role, '') NOT IN ('owner', 'app_admin', 'office', 'office_sales', 'plant', 'plant_manager', 'system') THEN
    RAISE EXCEPTION 'cancellation_trip_stage: role % may not', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role = 'plant_manager' AND NOT EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = p_trip AND p.plant_id = ctx.plant_scope()) THEN
    RETURN NULL;
  END IF;
  RETURN CASE
    WHEN EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = p_trip) THEN 'cancelled'
    WHEN EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'unloading_finished') THEN 'finished'
    WHEN EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'unloading_started') THEN 'unloading'
    WHEN EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'departed') THEN 'on_road'
    WHEN EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'loaded') THEN 'loaded'
    ELSE 'planned' END;
END $$;
--> statement-breakpoint
-- The change log validates what it is given: the old and the new rotation are of ONE plant, day and order, and the resources are those
-- of the two rotations (a forged change input cannot attribute a change to a truck or driver of another plant).
CREATE OR REPLACE FUNCTION public.log_dispatch_change(p_kind text, p_old uuid, p_new uuid, p_from_truck uuid, p_to_truck uuid, p_from_driver uuid, p_to_driver uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role(); v_id uuid := gen_random_uuid(); o public.trip_plan%ROWTYPE; n public.trip_plan%ROWTYPE;
BEGIN
  IF v_role IS NULL OR coalesce(v_role, '') NOT IN ('owner', 'app_admin', 'plant_manager') THEN
    RAISE EXCEPTION 'log_dispatch_change: role % may not', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO o FROM public.trip_plan WHERE id = p_old;
  IF NOT FOUND OR (v_role = 'plant_manager' AND o.plant_id IS DISTINCT FROM ctx.plant_scope()) THEN
    RAISE EXCEPTION 'log_dispatch_change: no such rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind = 'postpone' THEN
    IF p_new IS NOT NULL OR p_to_truck IS NOT NULL OR p_to_driver IS NOT NULL THEN
      RAISE EXCEPTION 'log_dispatch_change: a postponement has no new rotation' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_kind = 'reassign' THEN
    SELECT * INTO n FROM public.trip_plan WHERE id = p_new;
    IF p_new IS NULL OR NOT FOUND OR n.id = o.id OR n.plant_id IS DISTINCT FROM o.plant_id OR n.trip_date <> o.trip_date OR n.order_id <> o.order_id THEN
      RAISE EXCEPTION 'log_dispatch_change: the new rotation is not the same plant, day and order' USING ERRCODE = 'check_violation';
    END IF;
    IF p_to_truck IS DISTINCT FROM n.truck_id OR p_to_driver IS DISTINCT FROM n.driver_id THEN
      RAISE EXCEPTION 'log_dispatch_change: the new resources are not those of the new rotation' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'log_dispatch_change: unknown kind' USING ERRCODE = 'check_violation';
  END IF;
  IF p_from_truck IS DISTINCT FROM o.truck_id OR p_from_driver IS DISTINCT FROM o.driver_id THEN
    RAISE EXCEPTION 'log_dispatch_change: the old resources are not those of the old rotation' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.trip_dispatch_change (id, kind, old_trip_id, new_trip_id, plant_id, from_truck, to_truck, from_driver, to_driver, reason, created_by)
  VALUES (v_id, p_kind, p_old, p_new, o.plant_id, p_from_truck, p_to_truck, p_from_driver, p_to_driver, btrim(coalesce(p_reason, '')), ctx.user_id());
  RETURN v_id;
END $$;
