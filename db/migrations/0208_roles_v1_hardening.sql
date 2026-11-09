-- T8-B (decision of the owner, 9 Nov 2026): `partner` and `support` never get accounts in V1; a missing role is denied; the tracking of a
-- rotation is read by the owner, the app_admin and the plant manager of THAT plant only. Forward migration; nothing applied is edited.

-- 1. No account can be given the reserved roles by the application's logins. The migrator (tests, break-glass) is not restricted; the existing
--    rows, if any, are untouched (the roles stay in the policies as inert dead letters, see decision 126).
CREATE FUNCTION public.user_reserved_role_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.role IN ('partner', 'support')
     AND (TG_OP = 'INSERT' OR NEW.role IS DISTINCT FROM OLD.role)
     AND session_user NOT IN ('belgobeton_migrator') AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user) THEN
    RAISE EXCEPTION 'user: the role % has no accounts in V1', NEW.role USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER user_reserved_role_guard BEFORE INSERT OR UPDATE OF role ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.user_reserved_role_guard();
--> statement-breakpoint

-- 2. A missing role is denied by every definer door (R15B-07). In a function that says `IF ctx.role() NOT IN ('owner', ...) THEN RAISE`, a request
--    with NO role makes the test NULL, not true, so the guard does not fire. The doors that already test `IS NULL` first are fine; the others are
--    rewritten here, mechanically: `<role expression> NOT IN (` becomes `coalesce(<role expression>, '') NOT IN (` (a missing role is then
--    "not in the list" = refused) in every function of our schemas that still has the bare form. Only that token is changed; owner, grants,
--    search_path and the rest of each body are kept by CREATE OR REPLACE. tests/roles-hardening.int.test.ts scans the catalogue for the bare form.
DO $$
DECLARE r record; def text; fixed text; n integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname IN ('public', 'ctx', 'finance', 'audit') AND p.prokind = 'f'
  LOOP
    def := pg_catalog.pg_get_functiondef(r.oid);
    fixed := regexp_replace(def, '(ctx\.actor_role\(\)|ctx\.role\(\)|\mv_role)\s+NOT IN\s*\(', 'coalesce(\1, '''') NOT IN (', 'gi');
    IF fixed IS DISTINCT FROM def THEN
      EXECUTE fixed;
      n := n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0208: % definer functions made NULL-role safe', n;
END $$;
--> statement-breakpoint

-- 3. The two doors named by R15B-07 also say so explicitly.
CREATE OR REPLACE FUNCTION public.set_trip_estimate(p_plant uuid, p_zone uuid, p_stage text, p_minutes integer, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role(); v_id uuid := gen_random_uuid();
BEGIN
  IF v_role IS NULL OR coalesce(v_role, '') NOT IN ('owner', 'app_admin', 'plant_manager') THEN
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
CREATE OR REPLACE FUNCTION public.log_dispatch_change(p_kind text, p_old uuid, p_new uuid, p_from_truck uuid, p_to_truck uuid, p_from_driver uuid, p_to_driver uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role(); v_plant uuid; v_id uuid := gen_random_uuid();
BEGIN
  IF v_role IS NULL OR coalesce(v_role, '') NOT IN ('owner', 'app_admin', 'plant_manager') THEN
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

-- 4. trip_started (R15B-01): the unscoped definition stays for the database's own guards (not executable by the application); the application
--    gets a scoped door: true/false for the owner, the app_admin and the plant manager of the rotation's plant, false for everybody else
--    (so it is no oracle for a foreign plant, a partner or support).
ALTER FUNCTION public.trip_started(uuid) RENAME TO trip_started_internal;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_started_internal(uuid) FROM belgobeton_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.trip_plan_cancellation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_date date;
BEGIN
  SELECT p.trip_date INTO v_date FROM public.trip_plan p WHERE p.id = NEW.trip_id;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('trip_plan_day:' || v_date::text, 0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || NEW.trip_id::text, 0));
  IF public.trip_started_internal(NEW.trip_id) THEN
    RAISE EXCEPTION 'trip_plan: a rotation that has started cannot be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.trip_started(p_trip uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role();
BEGIN
  IF v_role IS NULL OR coalesce(v_role, '') NOT IN ('owner', 'app_admin', 'plant_manager', 'plant') THEN
    RETURN false;
  END IF;
  IF v_role = 'plant_manager' AND NOT EXISTS (
       SELECT 1 FROM public.trip_plan p WHERE p.id = p_trip AND p.plant_id IS NOT NULL AND p.plant_id = ctx.plant_scope()) THEN
    RETURN false;
  END IF;
  RETURN public.trip_started_internal(p_trip);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_started(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.trip_started(uuid) TO belgobeton_app;
--> statement-breakpoint

-- 5. The raw steps: owner (and app_admin through it) and the plant manager of the plant. No partner, no support.
DROP POLICY trip_event_read ON public.trip_event;
--> statement-breakpoint
CREATE POLICY trip_event_read ON public.trip_event FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'plant')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = trip_event.trip_id AND p.plant_id = ctx.plant_scope())));
--> statement-breakpoint
DROP POLICY support_read ON public.trip_event;
--> statement-breakpoint
DROP POLICY trip_event_insert ON public.trip_event;
--> statement-breakpoint
CREATE POLICY trip_event_insert ON public.trip_event FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'plant') AND created_by = ctx.user_id());
