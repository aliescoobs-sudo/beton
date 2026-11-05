-- F11 of the final review: the PIN attempt, its limit and the issue of a session are one serialised chain.
-- Before, the sign-in read the lock, checked the PIN, then counted a failure or cleared the counter in separate statements, so
-- parallel attempts could all read the state before the first lock and all be checked, and a late correct PIN could erase a lock
-- registered after it. Now the caller opens a transaction, takes the driver's PIN row with `field_login_lock` (FOR UPDATE, held
-- until the transaction ends), checks the lock, the PIN, counts the failure or clears the counter, and commits: attempts on one
-- driver run one after the other. `field_login_ok` also re-checks the lock itself, so a session is never issued on a locked driver.
CREATE FUNCTION public.field_login_lock(p_code text) RETURNS TABLE(
  driver_id uuid, user_id text, kind text, pin_hash text, failed integer, locked_until timestamptz, device_hash text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN QUERY
  SELECT d.id, d.user_id, d.kind, p.pin_hash, p.failed, p.locked_until,
         (SELECT v.device_hash FROM public.driver_device v WHERE v.driver_id = d.id AND v.revoked_at IS NULL)
    FROM public.driver d JOIN public.driver_pin p ON p.driver_id = d.id
   WHERE d.code = p_code AND d.status = 'active' AND d.user_id IS NOT NULL
     FOR UPDATE OF p;
END $$;
--> statement-breakpoint
-- A lock that has run out is cleared inside the same serialised step, so the count starts again from zero.
CREATE OR REPLACE FUNCTION public.field_login_failed(p_driver uuid, p_max integer, p_lock_minutes integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_failed integer;
BEGIN
  UPDATE public.driver_pin SET failed = 0, locked_until = NULL
   WHERE driver_id = p_driver AND locked_until IS NOT NULL AND locked_until <= now();
  UPDATE public.driver_pin SET failed = failed + 1,
         locked_until = CASE WHEN failed + 1 >= p_max THEN now() + make_interval(mins => p_lock_minutes) ELSE locked_until END
   WHERE driver_id = p_driver RETURNING failed INTO v_failed;
  RETURN v_failed;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.field_login_ok(p_driver uuid, p_device_hash text, p_label text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_live text;
BEGIN
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
REVOKE EXECUTE ON FUNCTION public.field_login_lock(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.field_login_lock(text) TO belgobeton_auth;
