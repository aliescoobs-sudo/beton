-- C3: what the pump planning screen offers: the active pump trucks and pump operators (code and name only). The roles that plan a
-- pump (and support) read it without reading the fleet or the driver list.
CREATE FUNCTION public.pump_options() RETURNS TABLE(kind text, id uuid, code text, label text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager', 'support') THEN
    RAISE EXCEPTION 'pump_options: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT 'pump'::text, t.id, t.code, t.plate FROM public.truck t WHERE t.kind = 'pump' AND t.status = 'active'
    UNION ALL
    SELECT 'operator'::text, d.id, d.code, d.name FROM public.driver d WHERE d.kind = 'pump_operator' AND d.status = 'active'
    ORDER BY 1, 3;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.pump_options() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.pump_options() TO belgobeton_app;
