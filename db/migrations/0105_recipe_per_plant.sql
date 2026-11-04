-- C4.1: recipes per plant (REQUIREMENTS-V1 §1, plant interview). A recette has an optional plant: NULL is the mix of all
-- plants; a plant's own mix wins over it for that plant from its own effective date. Versions are numbered and dated per
-- (type, plant scope); a published version stays sealed and insert-only, as before. The recette in force for an order is the
-- database's: the load guard below asks recette_in_force with the order's plant. Quantities only, no money.
ALTER TABLE public.recette ADD COLUMN plant_id uuid REFERENCES public.plant (id);
--> statement-breakpoint
ALTER TABLE public.recette DROP CONSTRAINT recette_concrete_type_id_version_key;
--> statement-breakpoint
ALTER TABLE public.recette DROP CONSTRAINT recette_concrete_type_id_effective_from_key;
--> statement-breakpoint
CREATE UNIQUE INDEX recette_scope_version_key ON public.recette
  (concrete_type_id, (coalesce(plant_id, '00000000-0000-0000-0000-000000000000'::uuid)), version);
--> statement-breakpoint
CREATE UNIQUE INDEX recette_scope_effective_key ON public.recette
  (concrete_type_id, (coalesce(plant_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.recette_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_version integer;
  v_last    date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.concrete_type_id::text || ':' || coalesce(NEW.plant_id::text, 'all'), 0));
  SELECT coalesce(max(version), 0), max(effective_from) INTO v_version, v_last
    FROM public.recette
   WHERE concrete_type_id = NEW.concrete_type_id AND plant_id IS NOT DISTINCT FROM NEW.plant_id;
  IF NEW.version <> v_version + 1 THEN
    RAISE EXCEPTION 'recette: version conflict, retry' USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'recette: effective_from must be after the previous version (%)', v_last
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- The recette in force (invoker: the caller's own row-level security applies, a plant manager sees his plant and the shared mix): the plant's own latest version that has started, else the all-plants one. NULL when neither exists.
CREATE FUNCTION public.recette_in_force(p_type uuid, p_plant uuid, p_date date) RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT r.id FROM public.recette r
   WHERE r.concrete_type_id = p_type AND r.effective_from <= p_date
     AND (r.plant_id IS NULL OR r.plant_id = p_plant)
   ORDER BY (r.plant_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.recette_in_force(uuid, uuid, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.recette_in_force(uuid, uuid, date) TO belgobeton_app, belgobeton_system, belgobeton_migrator;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'belgobeton_seed') THEN
    GRANT EXECUTE ON FUNCTION public.recette_in_force(uuid, uuid, date) TO belgobeton_seed;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.delivery_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order  public.sales_order%ROWTYPE;
  v_truck  public.truck%ROWTYPE;
  v_recette public.recette%ROWTYPE;
  v_orig   public.delivery%ROWTYPE;
  v_in_force uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery:order:' || NEW.order_id::text, 0));
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.delivery WHERE id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'delivery: unknown load to cancel' USING ERRCODE = 'check_violation';
    END IF;
    IF v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'delivery: a cancellation cannot be cancelled' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.order_id <> v_orig.order_id OR NEW.truck_id <> v_orig.truck_id OR NEW.recette_id <> v_orig.recette_id
       OR NEW.volume_l <> -v_orig.volume_l OR NEW.load_date < v_orig.load_date THEN
      RAISE EXCEPTION 'delivery: a cancellation negates its load exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_order FROM public.sales_order WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'delivery: unknown order' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = v_order.id) THEN
    RAISE EXCEPTION 'delivery: the order is cancelled' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_truck FROM public.truck WHERE id = NEW.truck_id;
  IF NOT FOUND OR v_truck.status <> 'active' THEN
    RAISE EXCEPTION 'delivery: the truck is not available' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.volume_l > v_truck.capacity_l THEN
    RAISE EXCEPTION 'delivery: the load is more than the truck can carry' USING ERRCODE = 'check_violation';
  END IF;
  -- No check against what is left to deliver any more: the excess is recorded by the AFTER trigger below.
  SELECT * INTO v_recette FROM public.recette WHERE id = NEW.recette_id;
  v_in_force := public.recette_in_force(v_order.concrete_type_id, v_order.plant_id, NEW.load_date);
  IF v_in_force IS NULL OR v_recette.id IS DISTINCT FROM v_in_force OR v_recette.concrete_type_id <> v_order.concrete_type_id THEN
    RAISE EXCEPTION 'delivery: not the recette in force on the load date' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A plant manager reads the mixes of his plant and the all-plants ones, not the other plant's.
DROP POLICY recette_read ON public.recette;
--> statement-breakpoint
CREATE POLICY recette_read ON public.recette FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'system')
         AND (ctx.plant_scope() IS NULL OR plant_id IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
DROP POLICY recette_line_read ON public.recette_line;
--> statement-breakpoint
CREATE POLICY recette_line_read ON public.recette_line FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'system')
         AND EXISTS (SELECT 1 FROM public.recette r WHERE r.id = recette_id
                       AND (ctx.plant_scope() IS NULL OR r.plant_id IS NULL OR r.plant_id = ctx.plant_scope())));
