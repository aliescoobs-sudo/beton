-- R18-04: a revoked phone cookie must not revive when the same phone is bound again. A release stamps revoked_at on the device row; the
-- next sign-in on that phone INSERTs a NEW row with the same device hash and a generation starting again at one, so a stolen old token
-- (same driver, same hash, generation reached again) matched the replacement session. The signed token now carries the IMMUTABLE id of
-- the device row; a check and a close require it. A row id is never reused, so a token of a released row can never match a later one.
-- Forward migration. Tokens issued before it carry no row id and are refused: each phone signs in once more.
DROP FUNCTION public.field_session_open(uuid, text);
--> statement-breakpoint
CREATE FUNCTION public.field_session_open(p_driver uuid, p_device_hash text) RETURNS TABLE(device_id uuid, gen integer)
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.driver_device SET session_gen = session_gen + 1
   WHERE driver_id = p_driver AND device_hash = p_device_hash AND revoked_at IS NULL
  RETURNING id, session_gen
$$;
--> statement-breakpoint
DROP FUNCTION public.field_session_check(uuid, text, integer);
--> statement-breakpoint
CREATE FUNCTION public.field_session_check(p_driver uuid, p_device_hash text, p_gen integer, p_device_id uuid)
  RETURNS TABLE(user_id text, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.user_id, d.kind FROM public.driver d
   WHERE d.id = p_driver AND d.status = 'active' AND d.user_id IS NOT NULL AND p_device_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.driver_device v
                  WHERE v.id = p_device_id AND v.driver_id = d.id AND v.revoked_at IS NULL
                    AND v.device_hash = p_device_hash AND v.session_gen = p_gen)
$$;
--> statement-breakpoint
DROP FUNCTION public.field_session_close(uuid, text, integer);
--> statement-breakpoint
CREATE FUNCTION public.field_session_close(p_driver uuid, p_device_hash text, p_gen integer, p_device_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_device_id IS NULL THEN RETURN false; END IF;
  UPDATE public.driver_device SET session_gen = session_gen + 1
   WHERE id = p_device_id AND driver_id = p_driver AND device_hash = p_device_hash
     AND revoked_at IS NULL AND session_gen = p_gen;
  RETURN FOUND;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['field_session_open(uuid, text)', 'field_session_check(uuid, text, integer, uuid)', 'field_session_close(uuid, text, integer, uuid)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_auth', f);
  END LOOP;
END $$;
