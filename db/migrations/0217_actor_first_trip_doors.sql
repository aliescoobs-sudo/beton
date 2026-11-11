-- R18-02: a request with a user id but NO role (app.role unset) made `IF NOT FOUND OR NOT (v_role IN (...) OR (v_role = 'plant_manager' AND ...))` evaluate to NULL
-- (NOT (NULL OR NULL)), and an IF on NULL does not raise: attach_trip_load, confirm_trip_delivered, confirm_trip_stage and correct_trip_stage ran for any
-- existing trip, in any plant or with none. The class is closed in three ways:
--   1. A shared helper, ctx.require_actor, rejects a missing/empty/unknown/non-staff actor FIRST, before ANY lookup of the target, with one message,
--      using a positive test (`IS NOT TRUE`), so a NULL can never mean "allowed".
--   2. A second helper, ctx.in_actor_scope, is the positive plant-scope predicate (a plant manager only for a plant that is his and not NULL), boolean never NULL.
--   3. The four doors use them; "no such trip" and "not your trip" are one answer. tests/definer-catalogue.int.test.ts lints the catalogue for the old shape.
-- Forward migration.
CREATE FUNCTION ctx.require_actor(p_door text, p_roles text[]) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.actor_role();
BEGIN
  -- the actor is a named user with one of the listed roles, and not a field (phone) identity; anything else, NULL included, is refused
  IF (v_role IS NOT NULL AND ctx.user_id() IS NOT NULL AND v_role = ANY (p_roles) AND ctx.driver_id() IS NULL) IS NOT TRUE THEN
    RAISE EXCEPTION '%: not your rotation', p_door USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END $$;
--> statement-breakpoint
CREATE FUNCTION ctx.in_actor_scope(p_global text[], p_plant uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    ctx.actor_role() = ANY (p_global)
    OR (ctx.actor_role() = 'plant_manager' AND p_plant IS NOT NULL AND p_plant = ctx.plant_scope()),
    false)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.require_actor(text, text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.in_actor_scope(text[], uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.require_actor(text, text[]) TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.in_actor_scope(text[], uuid) TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint
DO $$
DECLARE
  def text; fixed text; f text;
  head_old text;
BEGIN
  -- The four doors: the old guard, in the shape each currently has, is replaced by actor-first + positive scope.
  FOREACH f IN ARRAY ARRAY['attach_trip_load(uuid, uuid)', 'confirm_trip_delivered(uuid)', 'confirm_trip_stage(uuid, text, timestamptz)', 'correct_trip_stage(uuid, text, timestamptz, text)'] LOOP
    def := pg_catalog.pg_get_functiondef(('public.' || f)::regprocedure);
    fixed := def;
    -- (a) the actor is validated before the trip is read
    fixed := regexp_replace(fixed, E'(\n)(\\s*)SELECT \\* INTO v_trip FROM public\\.trip_plan WHERE id = p_trip;',
                            E'\\1\\2PERFORM ctx.require_actor(''' || split_part(f, '(', 1) || ''', ARRAY[''owner'', ''app_admin'', ''plant'', ''plant_manager''' ||
                            CASE WHEN f LIKE 'correct_trip_stage%' THEN ', ''office_sales''' ELSE '' END || ']);' ||
                            E'\\1\\2SELECT * INTO v_trip FROM public.trip_plan WHERE id = p_trip;');
    -- (b) the scope test is positive and never NULL
    fixed := regexp_replace(fixed,
      E'IF NOT FOUND OR (?:ctx\\.user_id\\(\\) IS NULL OR )?(?:ctx\\.driver_id\\(\\) IS NOT NULL OR )?(?:p_now IS NULL OR )?NOT \\(\\s*v_role IN \\(([^)]*)\\)\\s*OR \\(v_role = ''plant_manager'' AND v_trip\\.plant_id IS NOT NULL AND v_trip\\.plant_id = ctx\\.plant_scope\\(\\)\\)\\) THEN',
      E'IF NOT FOUND OR ctx.in_actor_scope(ARRAY[\\1], v_trip.plant_id) IS NOT TRUE' ||
      CASE WHEN f LIKE 'confirm_trip_stage%' THEN ' OR p_now IS NULL' ELSE '' END || ' THEN');
    IF fixed = def OR fixed NOT LIKE '%ctx.require_actor%' OR fixed NOT LIKE '%ctx.in_actor_scope%' THEN
      RAISE EXCEPTION '0217: % was not rewritten', f;
    END IF;
    EXECUTE fixed;
  END LOOP;
END $$;
--> statement-breakpoint
-- Found by the catalogue test once it called the doors with REAL ids: the same NULL trap in a SQL predicate. transfer_actor_ok returned NULL for a request with a
-- user but no role, `IF NOT NULL` does not raise, and set_fuel_tank_opening (and transfer_send / transfer_pickup / transfer_receive behind the same predicate)
-- went on to write. The predicate now answers true or false, never NULL.
CREATE OR REPLACE FUNCTION public.transfer_actor_ok(p_plant uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(ctx.actor_role() IN ('owner', 'app_admin') OR (ctx.actor_role() = 'plant_manager' AND p_plant = ctx.plant_scope()), false)
$$;
