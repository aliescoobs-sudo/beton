-- R19 step 0 (decision 219's named residuals, closed): the same whole-tuple rule for the last readers that admitted a NO-PLANT row to a plant manager or joined
-- another rotation without a scope test.
--   receipt_states, stock_arrived_pending: `plant_id IS NULL OR ...` handed a manager the receipt confirmation (note, files, purchase code, lines, quantities) of a
--     purchase with no plant or of another plant. A manager now reads a confirmation only when the confirmation, the purchase and (stock) the arrival line are all
--     of his plant; the owner, app_admin, the unbound plant account, purchases and support keep everything. Nothing is deleted.
--   driver_instructions: returned the truck code of the rotation an instruction "joins" (join_trip_id) whoever owned it. It is returned only when that rotation is
--     assigned to the same driver, or its plan, order and truck fall in the plant of the driver's own rotation (a plant, never NULL; a truck of that plant or of none).
-- Forward migration.
DO $$
DECLARE
  def text; fixed text; item record; n integer;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('receipt_states', ARRAY[
        'AND (ctx.plant_scope() IS NULL OR c.plant_id IS NULL OR c.plant_id = ctx.plant_scope())',
        'AND (ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR (ctx.plant_scope() IS NOT NULL AND c.plant_id = ctx.plant_scope() AND p.plant_id = ctx.plant_scope()))']),
      ('stock_arrived_pending', ARRAY[
        'AND (ctx.plant_scope() IS NULL OR a.plant_id IS NULL OR a.plant_id = ctx.plant_scope())',
        'AND (ctx.actor_role() IS DISTINCT FROM ''plant_manager'' OR (ctx.plant_scope() IS NOT NULL AND a.plant_id = ctx.plant_scope() AND c.plant_id = ctx.plant_scope()
               AND EXISTS (SELECT 1 FROM public.purchase pu WHERE pu.id = l.purchase_id AND pu.plant_id = ctx.plant_scope())))']),
      ('driver_instructions', ARRAY[
        '(SELECT k.code FROM public.trip_plan jp JOIN public.truck k ON k.id = jp.truck_id WHERE jp.id = i.join_trip_id)',
        '(SELECT k.code FROM public.trip_plan jp JOIN public.truck k ON k.id = jp.truck_id JOIN public.sales_order jo ON jo.id = jp.order_id
           WHERE jp.id = i.join_trip_id
             AND (jp.driver_id = v_driver
                  OR (p.plant_id IS NOT NULL AND jp.plant_id = p.plant_id AND jo.plant_id = p.plant_id AND (k.plant_id IS NULL OR k.plant_id = p.plant_id))))'])
    ) AS v(fname, repl)
  LOOP
    SELECT pg_catalog.pg_get_functiondef(p.oid) INTO def FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
     WHERE s.nspname = 'public' AND p.proname = item.fname;
    fixed := def;
    FOR n IN 1 .. array_length(item.repl, 1) BY 2 LOOP
      IF position(item.repl[n] IN fixed) = 0 THEN
        RAISE EXCEPTION '0226: %: the text to replace was not found: %', item.fname, left(item.repl[n], 80);
      END IF;
      fixed := replace(fixed, item.repl[n], item.repl[n + 1]);
    END LOOP;
    IF fixed = def THEN RAISE EXCEPTION '0226: % was not rewritten', item.fname; END IF;
    EXECUTE fixed;
  END LOOP;
END $$;
