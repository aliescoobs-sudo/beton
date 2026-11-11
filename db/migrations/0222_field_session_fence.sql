-- R18-05: a request admitted with a valid phone session kept running after the session was revoked: the sync route checked the token ONCE and then ran up to 200
-- independent transactions. The fence is checked INSIDE each transaction, at its start, and the row it checks is locked FOR SHARE until the transaction ends, so a revocation
-- (which UPDATEs the device row: a logout, a newer login, a release of the phone) waits for the transactions already admitted and every later transaction is refused:
-- no write of that phone commits after the revocation commits. Forward migration.
CREATE FUNCTION public.field_session_fence(p_driver uuid, p_device_id uuid, p_gen integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid;
BEGIN
  -- an account that is no longer an active user of its kind makes the actor check itself raise: that is the same answer, "ended"
  BEGIN
    v_me := ctx.driver_id();
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'field_session: ended' USING ERRCODE = 'insufficient_privilege';
  END;
  IF p_driver IS NULL OR p_device_id IS NULL OR p_gen IS NULL OR v_me IS DISTINCT FROM p_driver THEN
    RAISE EXCEPTION 'field_session: ended' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1
     FROM public.driver_device v
     JOIN public.driver d ON d.id = v.driver_id
     JOIN public."user" u ON u.id = d.user_id
    WHERE v.id = p_device_id AND v.driver_id = p_driver AND v.revoked_at IS NULL AND v.session_gen = p_gen
      AND d.status = 'active' AND u.status = 'active' AND u.role = d.kind
      FOR SHARE OF v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'field_session: ended' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.field_session_fence(uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.field_session_fence(uuid, uuid, integer) TO belgobeton_app;
