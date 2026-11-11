-- R19-02: related-row and NULL-plan leaks on READS. R18-01 closed the writes and dispatch_office / trip_timing / order_timeline; the sibling readers still trusted ONE
-- link of a tuple (the plan, or the order, or the job) and returned the rest joined to it, or admitted a plan with NO plant to a plant manager:
--   emergencies_open (0084)         `p.plant_id IS NULL OR ...` handed a manager the emergency note, driver, truck and client of a plan with no plant;
--   trip_delivery_exceptions (0210) scoped the plan only, then returned the joined order, truck and load and summed ALL deliveries and plans of an order;
--   trip_stages (0210)              trusted the plan's plant for the stage rows and for "load linked" (a load of another order);
--   delivery_note, order_chain (0095) scoped through the ORDER, not the delivery, and summed the children of an order of all plants; a manager and a NULL plant were equal;
--   pump_board, pump_waiting, pump_conflicts (0108) scoped the job, not the order, trip or second job joined to it;
--   driver_trips (0084)             checked the driver's assignment alone before returning the order's contact, site and the BL of a load of another order.
-- One shared predicate, ctx.manager_tuple_ok(plan plant, order plant, truck plant), is the positive test (a manager only for their own plant, never NULL, a truck of the
-- plant or of none), and each reader applies it to the PARENT and CHILD links it returns. The owner, app_admin and the unbound plant account keep seeing everything;
-- nothing is deleted. A rotation a phone driver is assigned to is shown only when its plan and its order agree on the plant (cross-plant ASSIGNMENT itself is unchanged),
-- and only its own order's load is shown as its BL. Forward migration.
CREATE FUNCTION ctx.manager_tuple_ok(p_plan_plant uuid, p_order_plant uuid, p_truck_plant uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(ctx.actor_role() = 'plant_manager' AND ctx.plant_scope() IS NOT NULL
                  AND p_plan_plant = ctx.plant_scope() AND p_order_plant = ctx.plant_scope()
                  AND (p_truck_plant IS NULL OR p_truck_plant = ctx.plant_scope()), false)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.manager_tuple_ok(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.manager_tuple_ok(uuid, uuid, uuid) TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint
DO $$
DECLARE
  def text; fixed text; item record; r text[]; n integer;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('emergencies_open', ARRAY[
        'AND (ctx.plant_scope() IS NULL OR p.plant_id IS NULL OR p.plant_id = ctx.plant_scope())',
        'AND (ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR ctx.manager_tuple_ok(p.plant_id, o.plant_id, k.plant_id))']),
      ('trip_delivery_exceptions', ARRAY[
        '(v_role = ''plant_manager'' AND p.plant_id IS NOT NULL AND p.plant_id = ctx.plant_scope())',
        '(v_role = ''plant_manager'' AND ctx.manager_tuple_ok(p.plant_id, o.plant_id, k.plant_id) AND (l.delivery_id IS NULL OR (d.order_id = p.order_id AND d.plant_id = ctx.plant_scope())))',
        'd2.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d2.id)',
        'd2.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d2.id) AND (v_role IS DISTINCT FROM ''plant_manager'' OR d2.plant_id = ctx.plant_scope())',
        'WHERE q.order_id = t.order_id',
        'WHERE q.order_id = t.order_id AND (v_role IS DISTINCT FROM ''plant_manager'' OR q.plant_id = ctx.plant_scope())']),
      ('trip_stages', ARRAY[
        'JOIN public.trip_plan p ON p.id = e.trip_id',
        E'JOIN public.trip_plan p ON p.id = e.trip_id\n    JOIN public.sales_order o ON o.id = p.order_id\n    JOIN public.truck k ON k.id = p.truck_id',
        '(v_driver IS NULL AND v_role = ''plant_manager'' AND p.plant_id IS NOT NULL AND p.plant_id = ctx.plant_scope())',
        '(v_driver IS NULL AND v_role = ''plant_manager'' AND ctx.manager_tuple_ok(p.plant_id, o.plant_id, k.plant_id))',
        '(v_driver IS NOT NULL AND p.driver_id = v_driver)',
        '(v_driver IS NOT NULL AND p.driver_id = v_driver AND p.plant_id IS NOT DISTINCT FROM o.plant_id)',
        'e.delivery_id IS NOT NULL,',
        '(e.delivery_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.delivery dl WHERE dl.id = e.delivery_id AND dl.order_id = p.order_id AND (v_role IS DISTINCT FROM ''plant_manager'' OR dl.plant_id = ctx.plant_scope()))),']),
      ('driver_trips', ARRAY[
        'WHERE p.driver_id = v_driver AND p.trip_date = p_date',
        'WHERE p.driver_id = v_driver AND p.trip_date = p_date AND p.plant_id IS NOT DISTINCT FROM o.plant_id',
        'JOIN public.delivery dl ON dl.id = e.delivery_id WHERE e.trip_id = p.id AND e.step = ''loaded''',
        'JOIN public.delivery dl ON dl.id = e.delivery_id WHERE e.trip_id = p.id AND e.step = ''loaded'' AND dl.order_id = p.order_id']),
      ('delivery_note', ARRAY[
        '(ctx.actor_role() <> ''plant_manager'' OR o.plant_id IS NOT DISTINCT FROM ctx.plant_scope())',
        '(ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR (ctx.plant_scope() IS NOT NULL AND d.plant_id = ctx.plant_scope() AND o.plant_id = ctx.plant_scope() AND (k.plant_id IS NULL OR k.plant_id = ctx.plant_scope())))']),
      ('order_chain', ARRAY[
        '(ctx.actor_role() <> ''plant_manager'' OR o.plant_id IS NOT DISTINCT FROM ctx.plant_scope())',
        '(ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR (ctx.plant_scope() IS NOT NULL AND o.plant_id = ctx.plant_scope()))',
        'WHERE p.order_id = o.id AND NOT EXISTS',
        'WHERE p.order_id = o.id AND (ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR p.plant_id = ctx.plant_scope()) AND NOT EXISTS',
        'd.order_id = o.id',
        'd.order_id = o.id AND (ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR d.plant_id = ctx.plant_scope())']),
      ('pump_board', ARRAY[
        '(ctx.plant_scope() IS NULL OR j.plant_id = ctx.plant_scope())',
        '(ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR (ctx.plant_scope() IS NOT NULL AND j.plant_id = ctx.plant_scope() AND (j.order_id IS NULL OR o.plant_id = ctx.plant_scope())))',
        'WHERE p.order_id = j.order_id AND p.trip_date = j.job_date',
        'WHERE p.order_id = j.order_id AND p.trip_date = j.job_date AND (ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR p.plant_id = ctx.plant_scope())']),
      ('pump_waiting', ARRAY[
        '(ctx.plant_scope() IS NULL OR o.plant_id = ctx.plant_scope())',
        '(ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR (ctx.plant_scope() IS NOT NULL AND o.plant_id = ctx.plant_scope()))']),
      ('pump_conflicts', ARRAY[
        '(ctx.plant_scope() IS NULL OR j.plant_id = ctx.plant_scope())',
        '(ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR (ctx.plant_scope() IS NOT NULL AND j.plant_id = ctx.plant_scope() AND (f.order_id IS NULL OR o.plant_id = ctx.plant_scope()) AND (f.trip_id IS NULL OR t.plant_id = ctx.plant_scope()) AND (f.other_job_id IS NULL OR j2.plant_id = ctx.plant_scope())))'])
    ) AS v(fname, repl)
  LOOP
    SELECT pg_catalog.pg_get_functiondef(p.oid) INTO def FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
     WHERE s.nspname = 'public' AND p.proname = item.fname;
    fixed := def;
    FOR n IN 1 .. array_length(item.repl, 1) BY 2 LOOP
      IF position(item.repl[n] IN fixed) = 0 THEN
        RAISE EXCEPTION '0225: %: the text to replace was not found: %', item.fname, left(item.repl[n], 80);
      END IF;
      fixed := replace(fixed, item.repl[n], item.repl[n + 1]);
    END LOOP;
    IF fixed = def THEN RAISE EXCEPTION '0225: % was not rewritten', item.fname; END IF;
    EXECUTE fixed;
  END LOOP;
END $$;
