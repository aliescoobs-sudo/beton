-- T19 item 2 (D245): the client reminder (relance) log. A reminder is a NOTE that somebody phoned or wrote to a client about money owed: no message is sent by KAYAS.
-- No data (decision 79). Forward migration. Insert-only, doors-only (no request role touches the table): written by log_client_reminder, read by client_reminder_list.
-- Both doors are actor first (ctx.require_admitted_actor) and open to owner, app_admin and office_sales only. Every row is audit-captured (hash chain).
CREATE TABLE public.client_reminder (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES public.client (id),
  note       text NOT NULL CHECK (note = btrim(note) AND length(note) BETWEEN 3 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX client_reminder_client_idx ON public.client_reminder (client_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE public.client_reminder ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.client_reminder FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.client_reminder FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY client_reminder_definer ON public.client_reminder FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION public.client_reminder_sealed() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $f$
BEGIN RAISE EXCEPTION 'client_reminder is insert-only' USING ERRCODE = 'integrity_constraint_violation'; END $f$;
--> statement-breakpoint
CREATE TRIGGER client_reminder_sealed BEFORE UPDATE OR DELETE ON public.client_reminder FOR EACH ROW EXECUTE FUNCTION public.client_reminder_sealed();
--> statement-breakpoint
SELECT audit.attach('public.client_reminder');
--> statement-breakpoint
CREATE FUNCTION public.log_client_reminder(p_client uuid, p_note text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('log_client_reminder');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_sales']) THEN
    RAISE EXCEPTION 'log_client_reminder: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.client c WHERE c.id = p_client) THEN
    RAISE EXCEPTION 'log_client_reminder: unknown client' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.client_reminder (id, client_id, note, created_by) VALUES (v_id, p_client, btrim(p_note), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.client_reminder_list(p_client uuid, p_limit integer)
  RETURNS TABLE(o_id uuid, o_client_id uuid, o_client_code text, o_client_name text, o_note text, o_created_at timestamptz, o_by_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('client_reminder_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_sales']) THEN
    RAISE EXCEPTION 'client_reminder_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT r.id, r.client_id, c.code, c.name, r.note, r.created_at, u.name
    FROM public.client_reminder r
    JOIN public.client c ON c.id = r.client_id
    LEFT JOIN public."user" u ON u.id = r.created_by
   WHERE p_client IS NULL OR r.client_id = p_client
   ORDER BY r.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 500), 2000));
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.log_client_reminder(uuid, text)', 'public.client_reminder_list(uuid, integer)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
