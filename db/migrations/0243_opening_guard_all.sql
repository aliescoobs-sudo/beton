-- T19 item 3: the opening-source guard states its role test with <> ALL (the repository rule: no bare NOT IN on a role). Same behaviour as 0242. No data.
CREATE OR REPLACE FUNCTION public.opening_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.source IS NOT NULL AND (ctx.actor_role() IS NULL OR ctx.actor_role() <> ALL (ARRAY['owner', 'app_admin'])) THEN
    RAISE EXCEPTION '%: only the owner or app_admin may mark a row as an opening row', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
