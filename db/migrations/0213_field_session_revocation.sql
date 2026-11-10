-- T10c (R17-07/08 follow-up, R15B-02): the phone's session can be ended ON THE SERVER. The signed token carries a generation; the bound phone's
-- row holds the current one. A login bumps it (the newer session supersedes any earlier token of that phone), a logout bumps it (every copy of
-- the token, wherever it is, stops working at once), and every request is checked against it. Deleting the cookie is no longer the only sign-out.
-- Forward migration. Tokens issued before it carry no generation and are refused: each phone signs in once more.
ALTER TABLE public.driver_device ADD COLUMN session_gen integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE FUNCTION public.field_session_open(p_driver uuid, p_device_hash text) RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.driver_device SET session_gen = session_gen + 1
   WHERE driver_id = p_driver AND device_hash = p_device_hash AND revoked_at IS NULL
  RETURNING session_gen
$$;
--> statement-breakpoint
DROP FUNCTION public.field_session_check(uuid, text);
--> statement-breakpoint
CREATE FUNCTION public.field_session_check(p_driver uuid, p_device_hash text, p_gen integer) RETURNS TABLE(user_id text, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.user_id, d.kind FROM public.driver d
   WHERE d.id = p_driver AND d.status = 'active' AND d.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.driver_device v
                  WHERE v.driver_id = d.id AND v.revoked_at IS NULL AND v.device_hash = p_device_hash AND v.session_gen = p_gen)
$$;
--> statement-breakpoint
-- Ends the session of THIS token: true when it was the live one (the generation moved), false when there was nothing to end (already ended,
-- another phone, revoked): never an error, so a repeated or late logout is harmless.
CREATE FUNCTION public.field_session_close(p_driver uuid, p_device_hash text, p_gen integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.driver_device SET session_gen = session_gen + 1
   WHERE driver_id = p_driver AND device_hash = p_device_hash AND revoked_at IS NULL AND session_gen = p_gen;
  RETURN FOUND;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['field_session_open(uuid, text)', 'field_session_check(uuid, text, integer)', 'field_session_close(uuid, text, integer)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_auth', f);
  END LOOP;
END $$;
