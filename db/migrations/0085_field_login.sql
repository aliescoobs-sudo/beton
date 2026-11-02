-- R4: the doors of the driver sign-in (PIN + one bound device). Reached by belgobeton_auth only; the PIN hash never leaves
-- the server. The application's own role has no access to driver_pin or driver_device.

CREATE FUNCTION public.field_login_lookup(p_code text) RETURNS TABLE(
  driver_id uuid, user_id text, kind text, pin_hash text, failed integer, locked_until timestamptz, device_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.user_id, d.kind, p.pin_hash, p.failed, p.locked_until,
         (SELECT v.device_hash FROM public.driver_device v WHERE v.driver_id = d.id AND v.revoked_at IS NULL)
    FROM public.driver d JOIN public.driver_pin p ON p.driver_id = d.id
   WHERE d.code = p_code AND d.status = 'active' AND d.user_id IS NOT NULL
$$;
--> statement-breakpoint
CREATE FUNCTION public.field_login_failed(p_driver uuid, p_max integer, p_lock_minutes integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_failed integer;
BEGIN
  UPDATE public.driver_pin SET failed = failed + 1,
         locked_until = CASE WHEN failed + 1 >= p_max THEN now() + make_interval(mins => p_lock_minutes) ELSE locked_until END
   WHERE driver_id = p_driver RETURNING failed INTO v_failed;
  RETURN v_failed;
END $$;
--> statement-breakpoint
-- A good PIN: clear the failures; bind the phone if the driver has none; refuse any other phone.
CREATE FUNCTION public.field_login_ok(p_driver uuid, p_device_hash text, p_label text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_live text;
BEGIN
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
-- Every request of the phone: the driver is still active and this phone is still the bound one.
CREATE FUNCTION public.field_session_check(p_driver uuid, p_device_hash text) RETURNS TABLE(user_id text, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.user_id, d.kind FROM public.driver d
   WHERE d.id = p_driver AND d.status = 'active' AND d.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.driver_device v WHERE v.driver_id = d.id AND v.revoked_at IS NULL AND v.device_hash = p_device_hash)
$$;
--> statement-breakpoint
CREATE FUNCTION public.field_set_pin(p_driver uuid, p_hash text, p_by text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.driver d WHERE d.id = p_driver AND d.user_id IS NOT NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO public.driver_pin (driver_id, pin_hash, set_by) VALUES (p_driver, p_hash, p_by)
  ON CONFLICT (driver_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed = 0, locked_until = NULL, set_by = EXCLUDED.set_by, set_at = now();
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.field_revoke_device(p_driver uuid, p_by text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.driver_device SET revoked_at = now(), revoked_by = p_by WHERE driver_id = p_driver AND revoked_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint
-- For the admin screen: which drivers have an account, a PIN, a bound phone. No hash.
CREATE FUNCTION public.field_accounts() RETURNS TABLE(
  driver_id uuid, code text, name text, kind text, user_id text, has_pin boolean, locked_until timestamptz, device_label text, device_bound_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.code, d.name, d.kind, d.user_id, p.driver_id IS NOT NULL, p.locked_until, v.label, v.bound_at
    FROM public.driver d LEFT JOIN public.driver_pin p ON p.driver_id = d.id
    LEFT JOIN public.driver_device v ON v.driver_id = d.id AND v.revoked_at IS NULL
   WHERE d.status = 'active' ORDER BY d.code
$$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['field_login_lookup(text)', 'field_login_failed(uuid, integer, integer)', 'field_login_ok(uuid, text, text)',
                           'field_session_check(uuid, text)', 'field_set_pin(uuid, text, text)', 'field_revoke_device(uuid, text)',
                           'field_accounts()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_auth', f);
  END LOOP;
END $$;
