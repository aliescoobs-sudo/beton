-- R8 (CP-PROD-PLAN, REQUIREMENTS-V1 §13; DECISIONS 148): Darija (Arabic script, code `ary`) as a third language. Each account has one main
-- language it can switch. The check on the account's language and on the language recorded with an assistant turn accept the new code;
-- an account may change only its own language, through one reviewed door.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname FROM pg_constraint c
     WHERE c.contype = 'c' AND c.connamespace = 'public'::regnamespace
       AND pg_get_constraintdef(c.oid) LIKE '%locale%' AND pg_get_constraintdef(c.oid) LIKE '%''fr''%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%''ary''%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (locale IN (''fr'', ''ar'', ''ary''))', r.tbl, r.conname);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.set_my_locale(p_locale text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_locale NOT IN ('fr', 'ar', 'ary') THEN
    RAISE EXCEPTION 'set_my_locale: unknown language' USING ERRCODE = 'check_violation';
  END IF;
  IF ctx.user_id() IS NULL THEN
    RAISE EXCEPTION 'set_my_locale: no account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public."user" SET locale = p_locale WHERE id = ctx.user_id()::text;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.set_my_locale(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_my_locale(text) TO belgobeton_app;
