-- T16 G4 (SPEC-cost-margin §3, §4, §13, M-A; D236, D237): the discharge method, the recette mapping and the selling price grid.
--   discharge_method (GOULOTTE | POMPE) on the order line (sales_order) and on the BL (delivery). The BL takes the method of its order (a reversing BL takes its original's);
--   an explicit method that disagrees with the order is refused. LEGACY ROWS (every order and BL written before this migration) keep NULL = "method not recorded": the
--   migration never invents a method (a silent GOULOTTE would invent a price and a cost). A NULL method is visible in the cost snapshot (T16 G6) as a missing key, never as a fallback.
--   NEW orders carry the method through create_order_with_method below; the 11-argument create_order door is kept for callers that have no method field yet (recorded in SECURITY-DEBT).
--   class_method_recette  (class, method, plant) -> recette, versioned by effective_from, insert-only. Which industrial recette the plant batches for a class and a method.
--   price_grid            (class, method) -> selling price per m3 in integer centimes HT, versioned by date, insert-only, flagged is_assumption. The pump is INCLUDED in the POMPE
--                         price: there is no pump invoice line (an invoice line is invoiced m3 x the order unit price, one line per BL, as before).
-- Writes: owner and app_admin only, each through a door with a typed reason (audited, hash-chained). Reads: no table grant to the application at all (a direct SELECT is refused 42501
-- for every role); the doors answer owner and app_admin (the mapping and the grid) and office_sales (the grid only: it keeps seeing the official selling price). The 13 Nov
-- price-confirmation rules (confirm_order_price: owner, app_admin) are untouched.
-- Forward migration. Migrations insert no data (decision 79): the A1 grid is in the pilot seed.

ALTER TABLE public.sales_order ADD COLUMN discharge_method text CHECK (discharge_method IN ('GOULOTTE', 'POMPE'));
--> statement-breakpoint
ALTER TABLE public.delivery ADD COLUMN discharge_method text CHECK (discharge_method IN ('GOULOTTE', 'POMPE'));
--> statement-breakpoint

CREATE TABLE public.class_method_recette (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concrete_type_id uuid NOT NULL REFERENCES public.concrete_type (id),
  discharge_method text NOT NULL CHECK (discharge_method IN ('GOULOTTE', 'POMPE')),
  plant_id       uuid REFERENCES public.plant (id),
  recette_id     uuid NOT NULL REFERENCES public.recette (id),
  effective_from date NOT NULL,
  is_assumption  boolean NOT NULL DEFAULT false,
  reason         text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX class_method_recette_scope_key ON public.class_method_recette
  (concrete_type_id, discharge_method, (coalesce(plant_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from);
--> statement-breakpoint
CREATE TABLE public.price_grid (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concrete_type_id uuid NOT NULL REFERENCES public.concrete_type (id),
  discharge_method text NOT NULL CHECK (discharge_method IN ('GOULOTTE', 'POMPE')),
  -- Centimes HT per m3, an integer, never a decimal.
  price_ht_per_m3_centimes bigint NOT NULL CHECK (price_ht_per_m3_centimes > 0),
  effective_from date NOT NULL,
  is_assumption  boolean NOT NULL DEFAULT false,
  reason         text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (concrete_type_id, discharge_method, effective_from)
);
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['class_method_recette', 'price_grid'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    -- no grant to the application: only the doors below (SECURITY DEFINER, run as the migrator) read or write
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql SET search_path = '''' AS $f$ BEGIN RAISE EXCEPTION ''%s is insert-only'' USING ERRCODE = ''integrity_constraint_violation''; END $f$',
                   t || '_sealed', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', t || '_sealed', t, t || '_sealed');
    EXECUTE format('SELECT audit.attach(%L)', 'public.' || t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Versions of one scope are strictly increasing in time (a date already used by a past BL can never be shadowed by a back-dated row); the lock serializes two writers.
CREATE FUNCTION public.price_grid_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_last date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('price_grid:' || NEW.concrete_type_id::text || ':' || NEW.discharge_method, 0));
  SELECT max(effective_from) INTO v_last FROM public.price_grid WHERE concrete_type_id = NEW.concrete_type_id AND discharge_method = NEW.discharge_method;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'price_grid: effective_from must be after the previous version (%)', v_last USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER price_grid_guard BEFORE INSERT ON public.price_grid FOR EACH ROW EXECUTE FUNCTION public.price_grid_guard();
--> statement-breakpoint
CREATE FUNCTION public.class_method_recette_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_last date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('class_method_recette:' || NEW.concrete_type_id::text || ':' || NEW.discharge_method || ':' || coalesce(NEW.plant_id::text, 'all'), 0));
  SELECT max(effective_from) INTO v_last FROM public.class_method_recette
   WHERE concrete_type_id = NEW.concrete_type_id AND discharge_method = NEW.discharge_method AND plant_id IS NOT DISTINCT FROM NEW.plant_id;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'class_method_recette: effective_from must be after the previous version (%)', v_last USING ERRCODE = 'check_violation';
  END IF;
  -- a plant mapping may only point at a recette of that plant or of all plants
  IF NEW.plant_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.recette r WHERE r.id = NEW.recette_id AND r.plant_id IS NOT NULL AND r.plant_id <> NEW.plant_id) THEN
    RAISE EXCEPTION 'class_method_recette: the recette belongs to another plant' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER class_method_recette_guard BEFORE INSERT ON public.class_method_recette FOR EACH ROW EXECUTE FUNCTION public.class_method_recette_guard();
--> statement-breakpoint

-- The method of a BL is the method of its order; a reversing BL takes its original's. NULL stays NULL (legacy / no method recorded): never invented.
CREATE FUNCTION public.delivery_method_fill() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_from text;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT d.discharge_method INTO v_from FROM public.delivery d WHERE d.id = NEW.reverses_id;
  ELSE
    SELECT o.discharge_method INTO v_from FROM public.sales_order o WHERE o.id = NEW.order_id;
  END IF;
  IF NEW.discharge_method IS NOT NULL AND v_from IS NOT NULL AND NEW.discharge_method <> v_from THEN
    RAISE EXCEPTION 'delivery: the discharge method is not the one of the order' USING ERRCODE = 'check_violation';
  END IF;
  NEW.discharge_method := coalesce(NEW.discharge_method, v_from);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_method_fill BEFORE INSERT ON public.delivery FOR EACH ROW EXECUTE FUNCTION public.delivery_method_fill();
--> statement-breakpoint
-- The method of a new order comes from the door that creates it (a transaction-local setting that only create_order_with_method sets, after validating it).
CREATE FUNCTION public.sales_order_method_fill() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v text := nullif(current_setting('app.order_discharge_method', true), '');
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT o.discharge_method INTO NEW.discharge_method FROM public.sales_order o WHERE o.id = NEW.reverses_id;
  ELSIF v IS NOT NULL AND NEW.discharge_method IS NULL THEN
    NEW.discharge_method := v;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_order_method_fill BEFORE INSERT ON public.sales_order FOR EACH ROW EXECUTE FUNCTION public.sales_order_method_fill();
--> statement-breakpoint

-- create_order with the discharge method. Same rules (it calls the 11-argument door), plus a method that must be GOULOTTE or POMPE.
CREATE FUNCTION public.create_order_with_method(p_client uuid, p_site uuid, p_zone uuid, p_type uuid, p_volume_l integer, p_delivery date, p_today date, p_brought_by uuid, p_quote uuid, p_plan jsonb, p_vat_default integer, p_method text)
  RETURNS TABLE(code text, id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('create_order_with_method');
  IF p_method IS NULL OR p_method <> ALL (ARRAY['GOULOTTE', 'POMPE']) THEN
    RAISE EXCEPTION 'create_order_with_method: the discharge method is GOULOTTE or POMPE' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.order_discharge_method', p_method, true);
  RETURN QUERY SELECT r.code, r.id FROM public.create_order(p_client, p_site, p_zone, p_type, p_volume_l, p_delivery, p_today, p_brought_by, p_quote, p_plan, p_vat_default) r;
  PERFORM set_config('app.order_discharge_method', '', true);
END $$;
--> statement-breakpoint

-- Writes (owner, app_admin; a typed reason; a replacement is a new row with is_assumption = false).
CREATE FUNCTION public.set_price_grid(p_class uuid, p_method text, p_price_centimes bigint, p_effective_from date, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('set_price_grid');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'set_price_grid: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.concrete_type t WHERE t.id = p_class AND t.status = 'active') THEN
    RAISE EXCEPTION 'set_price_grid: unknown class' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.price_grid (id, concrete_type_id, discharge_method, price_ht_per_m3_centimes, effective_from, is_assumption, reason, created_by)
  VALUES (v_id, p_class, p_method, p_price_centimes, p_effective_from, false, btrim(p_reason), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.set_class_method_recette(p_class uuid, p_method text, p_plant uuid, p_recette uuid, p_effective_from date, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('set_class_method_recette');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'set_class_method_recette: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.concrete_type t WHERE t.id = p_class AND t.status = 'active')
     OR NOT EXISTS (SELECT 1 FROM public.recette r WHERE r.id = p_recette)
     OR (p_plant IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.plant p WHERE p.id = p_plant)) THEN
    RAISE EXCEPTION 'set_class_method_recette: unknown class, recette or plant' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.class_method_recette (id, concrete_type_id, discharge_method, plant_id, recette_id, effective_from, is_assumption, reason, created_by)
  VALUES (v_id, p_class, p_method, p_plant, p_recette, p_effective_from, false, btrim(p_reason), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Reads. The grid: owner, app_admin and office_sales (the official selling price). The mapping: owner, app_admin.
CREATE FUNCTION public.price_grid_list()
  RETURNS TABLE(o_id uuid, o_class_code text, o_method text, o_price_centimes bigint, o_effective_from date, o_is_assumption boolean, o_reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('price_grid_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_sales']) THEN
    RAISE EXCEPTION 'price_grid_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT g.id, t.code, g.discharge_method, g.price_ht_per_m3_centimes, g.effective_from, g.is_assumption, g.reason
    FROM public.price_grid g JOIN public.concrete_type t ON t.id = g.concrete_type_id
   ORDER BY t.code, g.discharge_method, g.effective_from DESC;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.class_method_recette_list()
  RETURNS TABLE(o_id uuid, o_class_code text, o_method text, o_plant_id uuid, o_recette_id uuid, o_effective_from date, o_is_assumption boolean, o_reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('class_method_recette_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'class_method_recette_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT m.id, t.code, m.discharge_method, m.plant_id, m.recette_id, m.effective_from, m.is_assumption, m.reason
    FROM public.class_method_recette m JOIN public.concrete_type t ON t.id = m.concrete_type_id
   ORDER BY t.code, m.discharge_method, m.effective_from DESC;
END $$;
--> statement-breakpoint

-- Internal lookups (never granted to a request role): the grid price and the mapped recette in force on a date. The plant's own mapping wins over the all-plants one.
CREATE FUNCTION public._price_grid_in_force(p_class uuid, p_method text, p_date date) RETURNS TABLE(id uuid, price_centimes bigint, is_assumption boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.id, g.price_ht_per_m3_centimes, g.is_assumption FROM public.price_grid g
   WHERE g.concrete_type_id = p_class AND g.discharge_method = p_method AND g.effective_from <= p_date
   ORDER BY g.effective_from DESC LIMIT 1
$$;
--> statement-breakpoint
CREATE FUNCTION public._class_method_recette_in_force(p_class uuid, p_method text, p_plant uuid, p_date date) RETURNS TABLE(id uuid, recette_id uuid, is_assumption boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.id, m.recette_id, m.is_assumption FROM public.class_method_recette m
   WHERE m.concrete_type_id = p_class AND m.discharge_method = p_method AND m.effective_from <= p_date
     AND (m.plant_id IS NULL OR m.plant_id = p_plant)
   ORDER BY (m.plant_id IS NOT NULL) DESC, m.effective_from DESC LIMIT 1
$$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public._price_grid_in_force(uuid, text, date)', 'public._class_method_recette_in_force(uuid, text, uuid, date)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.create_order_with_method(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer, text)',
                           'public.set_price_grid(uuid, text, bigint, date, text)', 'public.set_class_method_recette(uuid, text, uuid, uuid, date, text)',
                           'public.price_grid_list()', 'public.class_method_recette_list()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
--> statement-breakpoint

-- The audit rows of the cost and price-grid tables (they carry the figures) are for owner and app_admin only (policy role owner), like the finance tables (0200). The list already names
-- the T16 G5 and G6 tables so no later migration has to redefine the function.
CREATE FUNCTION audit.is_cost_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('price_grid', 'class_method_recette', 'cost_rate', 'fuel_norm', 'bl_cost_snapshot', 'bl_cost_snapshot_line')
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION audit.is_cost_table(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.is_cost_table(text) TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY cost_audit_visibility ON public.audit_event AS RESTRICTIVE FOR SELECT TO belgobeton_app
  USING (NOT audit.is_cost_table(table_name) OR ctx.role() = 'owner');
