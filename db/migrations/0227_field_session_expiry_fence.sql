-- R19-05: a phone request admitted just before its token expired kept its identity for as long as it ran: the route checked the expiry once, before it read a body
-- the client controls, and the per-transaction fence (0222) checked the device generation and status only. The token's verified expiry now travels with the session
-- user and the fence refuses, INSIDE every transaction and against the database's own clock (now(), never a value the client sends), a
-- session whose expiry has passed. The fence also takes a SHARED advisory lock on the driver's account (row locks cannot be used: the driver table is FORCE row-level secured and a
-- row lock needs the UPDATE policy), and every change of a linked account's status or role (a trigger on "user" and on driver) takes the same lock EXCLUSIVELY: a change
-- made while a batch is on its way waits for the transactions already admitted, and every later transaction is refused.
-- Forward migration: the three-argument fence is replaced by the four-argument one.
DROP FUNCTION public.field_session_fence(uuid, uuid, integer);
--> statement-breakpoint
CREATE FUNCTION public.field_session_fence(p_driver uuid, p_device_id uuid, p_gen integer, p_exp bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid;
BEGIN
  IF p_driver IS NULL OR p_device_id IS NULL OR p_gen IS NULL OR p_exp IS NULL THEN
    RAISE EXCEPTION 'field_session: ended' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- shared, held until this transaction ends: an account change (exclusive, below) waits for us; one that committed before we got here is seen by the reads that follow
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('field_acct:' || p_driver::text, 0));
  -- an account that is no longer an active user of its kind makes the actor check itself raise: that is the same answer, "ended"
  BEGIN
    v_me := ctx.driver_id();
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'field_session: ended' USING ERRCODE = 'insufficient_privilege';
  END;
  IF v_me IS DISTINCT FROM p_driver OR extract(epoch FROM now()) >= p_exp THEN
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
REVOKE EXECUTE ON FUNCTION public.field_session_fence(uuid, uuid, integer, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.field_session_fence(uuid, uuid, integer, bigint) TO belgobeton_app;
--> statement-breakpoint
-- A change of status or role of a user, and of the status of a driver, waits for the phone transactions already admitted for the drivers it concerns.
CREATE FUNCTION public.field_account_change_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d uuid;
BEGIN
  IF TG_TABLE_NAME = 'driver' THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('field_acct:' || OLD.id::text, 0));
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.role IS DISTINCT FROM OLD.role THEN
    FOR d IN SELECT x.id FROM public.driver x WHERE x.user_id = OLD.id ORDER BY x.id LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('field_acct:' || d::text, 0));
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_field_account_change_lock BEFORE UPDATE ON public.driver FOR EACH ROW EXECUTE FUNCTION public.field_account_change_lock();
--> statement-breakpoint
CREATE TRIGGER a_field_account_change_lock BEFORE UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.field_account_change_lock();
