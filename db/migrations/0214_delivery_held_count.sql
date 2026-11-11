-- T10a addendum: the COUNT of the deliveries the driver declared but the plant has not put through the billing gate (kinds `declared_no_record` and
-- `unconfirmed`) is visible to the office roles that work the invoice queue (office_sales, office), as a number only: no trip, order, client, truck
-- or driver. The details stay with the owner, the app_admin and the plant side (`trip_delivery_exceptions`, unchanged). Forward migration.
-- The count is taken from the same query as the details: an internal copy of the function without its role gate and with an "all plants" switch,
-- made mechanically from the applied definition (so the two cannot drift apart) and NOT executable by the application.
DO $$
DECLARE def text; fixed text;
BEGIN
  def := pg_catalog.pg_get_functiondef('public.trip_delivery_exceptions(date, date)'::regprocedure);
  fixed := replace(def, 'public.trip_delivery_exceptions(p_from date, p_to date)', 'public.trip_delivery_exceptions_internal(p_from date, p_to date, p_all boolean)');
  fixed := replace(fixed, E'IF ctx.driver_id() IS NOT NULL OR v_role IS DISTINCT FROM ''owner'' AND v_role IS DISTINCT FROM ''app_admin''\n     AND v_role IS DISTINCT FROM ''plant'' AND v_role IS DISTINCT FROM ''plant_manager'' THEN', 'IF false THEN');
  fixed := replace(fixed, '(v_role IN (''owner'', ''app_admin'', ''plant'')', '(p_all OR v_role IN (''owner'', ''app_admin'', ''plant'')');
  IF fixed = def OR position('IF false THEN' in fixed) = 0 OR position('p_all OR' in fixed) = 0 THEN
    RAISE EXCEPTION '0214: trip_delivery_exceptions was not rewritten as expected';
  END IF;
  EXECUTE fixed;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_delivery_exceptions_internal(date, date, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_delivery_exceptions_internal(date, date, boolean) FROM belgobeton_app;
--> statement-breakpoint
CREATE FUNCTION public.trip_delivery_held_count(p_from date, p_to date) RETURNS integer
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role(); v_all boolean;
BEGIN
  IF ctx.driver_id() IS NOT NULL OR v_role IS NULL
     OR coalesce(v_role, '') NOT IN ('owner', 'app_admin', 'plant', 'plant_manager', 'office_sales', 'office') THEN
    RAISE EXCEPTION 'trip_delivery_held_count: role % may not read it', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- the office roles count every plant (and a rotation with no plant: the office dispatch roles see those, decision 207); the plant side is scoped as for the details
  v_all := v_role IN ('office_sales', 'office');
  RETURN (SELECT count(*)::integer FROM public.trip_delivery_exceptions_internal(p_from, p_to, v_all) e
           WHERE e.kind IN ('declared_no_record', 'unconfirmed'));
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_delivery_held_count(date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.trip_delivery_held_count(date, date) TO belgobeton_app;
