-- R18-03: reserved roles (partner, support) at the database actor boundary, the session table, the admission cleanup and the field doors. Forward migration.
--   1. ctx.actor_role() (what every RLS policy and every definer asks) no longer validates a request whose stored role is reserved: it raises like any role that does
--      not match its account. The order view, the invoice queue and every other reader go through it. The switch is a function pinned to its own setting
--      (ctx.reserved_boundary_on, a constant owned by the migrator: no session can change it); the policy-matrix tests of the reserved roles replace it in the
--      TEST database only, and the server refuses to start when it is off.
--   2. A session cannot be inserted OR retargeted (UPDATE of its user) onto a reserved-role account by the application's logins.
--   3. The cleanup is its own committed step: revoke_reserved_sessions() deletes the sessions and RETURNS; admit_no_reserved_accounts() only checks and raises.
--      (Before, one function deleted and then raised, and the raise rolled the delete back: an active reserved account kept its old session.)
--   4. The phone's doors (login lock, login ok, session open, session check) require an ACTIVE linked user whose role is the driver's kind.
CREATE OR REPLACE FUNCTION ctx.reserved_boundary_on() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.reserved_boundary_on() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.reserved_boundary_on() TO belgobeton_app, belgobeton_auth, belgobeton_system, belgobeton_migrator;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ctx.actor_role() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := nullif(current_setting('app.role', true), '');
  v_user uuid := ctx.user_id();
  v_ok   boolean := false;
BEGIN
  IF v_role IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_role = 'system' THEN
    v_ok := v_user IN ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002');
  ELSIF v_role = 'anonymous' THEN
    v_ok := v_user = '00000000-0000-7000-8000-000000000000';
  ELSIF v_user IS NOT NULL THEN
    SELECT true INTO v_ok FROM public."user" u
     WHERE u.id = v_user::text AND u.role = v_role AND u.status = 'active'
       -- R18-03: a reserved role is not a usable actor, even for an account that exists and is active
       AND NOT (u.role IN ('partner', 'support') AND ctx.reserved_boundary_on());
  END IF;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'ctx: request role % does not match the stored role of user %', v_role, v_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END $$;
--> statement-breakpoint

-- 2. Sessions: insert and retarget.
CREATE TRIGGER session_reserved_role_guard_update BEFORE UPDATE OF "userId" ON public."session"
  FOR EACH ROW EXECUTE FUNCTION public.session_reserved_role_guard();
--> statement-breakpoint

-- 3. The cleanup and the check, separated.
CREATE FUNCTION public.revoke_reserved_sessions() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM public."session" s USING public."user" u WHERE s."userId" = u.id AND u.role IN ('partner', 'support');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.revoke_reserved_sessions() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.revoke_reserved_sessions() TO belgobeton_auth, belgobeton_system, belgobeton_migrator;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admit_no_reserved_accounts() RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE n bigint;
BEGIN
  -- the check only: the sessions are revoked by revoke_reserved_sessions(), called (and committed) BEFORE this, so a refusal cannot undo the revocation
  n := public.usable_reserved_role_accounts();
  IF n > 0 THEN
    RAISE EXCEPTION 'admission: % usable account(s) hold a reserved role (partner or support); disable them (or give them a V1 role) before this version starts', n
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint

-- 4. The phone's doors need an active linked user of the matching kind.
CREATE OR REPLACE FUNCTION public.field_login_lock(p_code text)
 RETURNS TABLE(driver_id uuid, user_id text, kind text, pin_hash text, failed integer, locked_until timestamp with time zone, device_hash text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN QUERY
  SELECT d.id, d.user_id, d.kind, p.pin_hash, p.failed, p.locked_until,
         (SELECT v.device_hash FROM public.driver_device v WHERE v.driver_id = d.id AND v.revoked_at IS NULL)
    FROM public.driver d JOIN public.driver_pin p ON p.driver_id = d.id
   WHERE d.code = p_code AND d.status = 'active' AND d.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public."user" u WHERE u.id = d.user_id AND u.status = 'active' AND u.role = d.kind)
     FOR UPDATE OF p;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.field_login_ok(p_driver uuid, p_device_hash text, p_label text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_live text;
BEGIN
  -- no session for a driver whose linked account is not an active user of the driver's kind (a status or role change since the PIN was set)
  IF NOT EXISTS (SELECT 1 FROM public.driver d JOIN public."user" u ON u.id = d.user_id
                  WHERE d.id = p_driver AND d.status = 'active' AND u.status = 'active' AND u.role = d.kind) THEN
    RETURN 'locked';
  END IF;
  -- Never issue a session on a locked driver, and never clear a lock that is still running.
  IF EXISTS (SELECT 1 FROM public.driver_pin WHERE driver_id = p_driver AND locked_until IS NOT NULL AND locked_until > now()) THEN
    RETURN 'locked';
  END IF;
  SELECT v.device_hash INTO v_live FROM public.driver_device v WHERE v.driver_id = p_driver AND v.revoked_at IS NULL;
  IF v_live IS NULL THEN
    INSERT INTO public.driver_device (id, driver_id, device_hash, label) VALUES (gen_random_uuid(), p_driver, p_device_hash, left(p_label, 80));
    UPDATE public.driver_pin SET failed = 0, locked_until = NULL WHERE driver_id = p_driver;
    RETURN 'bound';
  ELSIF v_live = p_device_hash THEN
    UPDATE public.driver_pin SET failed = 0, locked_until = NULL WHERE driver_id = p_driver;
    RETURN 'known';
  END IF;
  RETURN 'other_device';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.field_session_open(p_driver uuid, p_device_hash text) RETURNS TABLE(device_id uuid, gen integer)
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.driver_device v SET session_gen = v.session_gen + 1
   WHERE v.driver_id = p_driver AND v.device_hash = p_device_hash AND v.revoked_at IS NULL
     AND EXISTS (SELECT 1 FROM public.driver d JOIN public."user" u ON u.id = d.user_id
                  WHERE d.id = p_driver AND d.status = 'active' AND u.status = 'active' AND u.role = d.kind)
  RETURNING v.id, v.session_gen
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.field_session_check(p_driver uuid, p_device_hash text, p_gen integer, p_device_id uuid)
  RETURNS TABLE(user_id text, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.user_id, d.kind FROM public.driver d
   WHERE d.id = p_driver AND d.status = 'active' AND d.user_id IS NOT NULL AND p_device_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public."user" u WHERE u.id = d.user_id AND u.status = 'active' AND u.role = d.kind)
     AND EXISTS (SELECT 1 FROM public.driver_device v
                  WHERE v.id = p_device_id AND v.driver_id = d.id AND v.revoked_at IS NULL
                    AND v.device_hash = p_device_hash AND v.session_gen = p_gen)
$$;
