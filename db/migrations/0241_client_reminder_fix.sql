-- T19 item 2: client_reminder_list joined "user".id (text) to created_by (uuid): the join compares as text. Forward fix of 0240 (no data).
CREATE OR REPLACE FUNCTION public.client_reminder_list(p_client uuid, p_limit integer)
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
    LEFT JOIN public."user" u ON u.id = r.created_by::text
   WHERE p_client IS NULL OR r.client_id = p_client
   ORDER BY r.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 500), 2000));
END $$;
