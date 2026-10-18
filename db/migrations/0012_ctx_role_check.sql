-- DECISIONS 76 (CP4): defence in depth. The request role set by the app (app.role) must match the stored role of
-- app.user_id: an active user with exactly that role, or the fixed system/bootstrap/anonymous actors. ctx.role() is
-- used by every RLS policy and by the audit writer, so a mismatch aborts the statement, and the transaction, wherever
-- the role is consulted. Actor ids: src/modules/platform-security/auth/actors.ts.
CREATE OR REPLACE FUNCTION ctx.role() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
     WHERE u.id = v_user::text AND u.role = v_role AND u.status = 'active';
  END IF;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'ctx: request role % does not match the stored role of user %', v_role, v_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END $$;
