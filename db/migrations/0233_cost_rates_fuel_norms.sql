-- T16 G5 (SPEC-cost-margin §5, §8, §11, M-B; D236, D237): the cost rates, the fuel norms and the delivered-to-plant price extension of purchase_price. All DATA, all versioned, all insert-only.
--   cost_rate               (key, unit, value in integer centimes, effective_from, plant optional, is_assumption, source_note). The keys are a closed list (a typo is refused, a new
--                           key is a migration): diesel_per_l (centimes per litre), delivery_other_per_m3 (driver, maintenance and tyres of the trip, per m3), pump_per_m3, plant_per_m3, overhead_per_m3.
--                           The plant's own rate wins over the all-plants one. Versions of a scope go forward in time.
--   fuel_norm               litres per trip, per hour and per km of a truck KIND or of one TRUCK, stored in integer MILLILITRES (no decimal litre: 22 L = 22000). A truck's own norm wins over its kind's.
--   purchase_price_transport  the transport that makes a component price a DELIVERED-to-plant price (price + transport, per purchase unit). A separate doors-only table, not a column of purchase_price,
--                           because purchase_price is read by the purchasing office and a transport cost is a cost figure (owner and app_admin only). One purchase price may have several rows (a
--                           replacement is a new row); the latest wins. A price with no transport row is "transport not recorded" and the snapshot (G6) says so.
-- Same access model as 0232: no privilege for the application login on any of the three tables; written only by the doors below (owner, app_admin, a typed reason, audited, hash-chained),
-- read only by the list doors (owner, app_admin). A replacement of an assumed value is a new row with is_assumption = false. Migrations insert no data (decision 79): the A1 values are in the pilot seed.
-- Forward migration.
CREATE TABLE public.cost_rate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_key       text NOT NULL CHECK (rate_key IN ('diesel_per_l', 'delivery_other_per_m3', 'pump_per_m3', 'plant_per_m3', 'overhead_per_m3')),
  unit           text NOT NULL CHECK (unit IN ('centimes_per_l', 'centimes_per_m3')),
  value_centimes bigint NOT NULL CHECK (value_centimes >= 0),
  effective_from date NOT NULL,
  plant_id       uuid REFERENCES public.plant (id),
  is_assumption  boolean NOT NULL DEFAULT false,
  source_note    text NOT NULL CHECK (source_note = btrim(source_note) AND length(source_note) BETWEEN 3 AND 300),
  reason         text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((rate_key = 'diesel_per_l') = (unit = 'centimes_per_l'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX cost_rate_scope_key ON public.cost_rate (rate_key, (coalesce(plant_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from);
--> statement-breakpoint
CREATE TABLE public.fuel_norm (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  truck_kind     text CHECK (truck_kind IN ('mixer', 'pump', 'external', 'hauler')),
  truck_id       uuid REFERENCES public.truck (id),
  per_trip_ml    bigint CHECK (per_trip_ml > 0),
  per_hour_ml    bigint CHECK (per_hour_ml > 0),
  per_km_ml      bigint CHECK (per_km_ml > 0),
  effective_from date NOT NULL,
  is_assumption  boolean NOT NULL DEFAULT false,
  source_note    text NOT NULL CHECK (source_note = btrim(source_note) AND length(source_note) BETWEEN 3 AND 300),
  reason         text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((truck_kind IS NULL) <> (truck_id IS NULL)),
  CHECK (per_trip_ml IS NOT NULL OR per_hour_ml IS NOT NULL OR per_km_ml IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX fuel_norm_scope_key ON public.fuel_norm
  ((coalesce(truck_kind, '')), (coalesce(truck_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from);
--> statement-breakpoint
CREATE TABLE public.purchase_price_transport (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_price_id uuid NOT NULL REFERENCES public.purchase_price (id),
  -- Centimes HT per purchase unit of that price: an integer, never a decimal.
  transport_centimes bigint NOT NULL CHECK (transport_centimes >= 0),
  is_assumption     boolean NOT NULL DEFAULT false,
  source_note       text NOT NULL CHECK (source_note = btrim(source_note) AND length(source_note) BETWEEN 3 AND 300),
  reason            text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX purchase_price_transport_price_idx ON public.purchase_price_transport (purchase_price_id, created_at DESC);
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cost_rate', 'fuel_norm', 'purchase_price_transport'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql SET search_path = '''' AS $f$ BEGIN RAISE EXCEPTION ''%s is insert-only'' USING ERRCODE = ''integrity_constraint_violation''; END $f$',
                   t || '_sealed', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', t || '_sealed', t, t || '_sealed');
    EXECUTE format('SELECT audit.attach(%L)', 'public.' || t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Versions of one scope go forward in time (a date a past BL already used can never be shadowed by a back-dated row); the lock serializes two writers.
CREATE FUNCTION public.cost_rate_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_last date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cost_rate:' || NEW.rate_key || ':' || coalesce(NEW.plant_id::text, 'all'), 0));
  SELECT max(effective_from) INTO v_last FROM public.cost_rate WHERE rate_key = NEW.rate_key AND plant_id IS NOT DISTINCT FROM NEW.plant_id;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'cost_rate: effective_from must be after the previous version (%)', v_last USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cost_rate_guard BEFORE INSERT ON public.cost_rate FOR EACH ROW EXECUTE FUNCTION public.cost_rate_guard();
--> statement-breakpoint
CREATE FUNCTION public.fuel_norm_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_last date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fuel_norm:' || coalesce(NEW.truck_kind, NEW.truck_id::text), 0));
  SELECT max(effective_from) INTO v_last FROM public.fuel_norm
   WHERE truck_kind IS NOT DISTINCT FROM NEW.truck_kind AND truck_id IS NOT DISTINCT FROM NEW.truck_id;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'fuel_norm: effective_from must be after the previous version (%)', v_last USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fuel_norm_guard BEFORE INSERT ON public.fuel_norm FOR EACH ROW EXECUTE FUNCTION public.fuel_norm_guard();
--> statement-breakpoint

-- The doors read purchase_price as the migrator (they run SECURITY DEFINER); no request role gains anything from this policy (it is TO belgobeton_migrator only).
CREATE POLICY purchase_price_definer_read ON public.purchase_price FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- The audit rows of the new tables hold figures: the cost list (0232) gains purchase_price_transport (it already names cost_rate and fuel_norm).
CREATE OR REPLACE FUNCTION audit.is_cost_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('price_grid', 'class_method_recette', 'cost_rate', 'fuel_norm', 'purchase_price_transport', 'bl_cost_snapshot', 'bl_cost_snapshot_line')
$$;
--> statement-breakpoint

-- Writes: owner and app_admin only, a typed reason; a replacement of an assumed value is a new row (is_assumption = false, whatever the old row was).
CREATE FUNCTION public.set_cost_rate(p_key text, p_value_centimes bigint, p_effective_from date, p_plant uuid, p_source_note text, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('set_cost_rate');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'set_cost_rate: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_plant IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.plant p WHERE p.id = p_plant) THEN
    RAISE EXCEPTION 'set_cost_rate: unknown plant' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.cost_rate (id, rate_key, unit, value_centimes, effective_from, plant_id, is_assumption, source_note, reason, created_by)
  VALUES (v_id, p_key, CASE WHEN p_key = 'diesel_per_l' THEN 'centimes_per_l' ELSE 'centimes_per_m3' END, p_value_centimes, p_effective_from, p_plant, false, btrim(p_source_note), btrim(p_reason), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.set_fuel_norm(p_truck_kind text, p_truck uuid, p_per_trip_ml bigint, p_per_hour_ml bigint, p_per_km_ml bigint, p_effective_from date, p_source_note text, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('set_fuel_norm');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'set_fuel_norm: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_truck IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.truck t WHERE t.id = p_truck) THEN
    RAISE EXCEPTION 'set_fuel_norm: unknown truck' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.fuel_norm (id, truck_kind, truck_id, per_trip_ml, per_hour_ml, per_km_ml, effective_from, is_assumption, source_note, reason, created_by)
  VALUES (v_id, p_truck_kind, p_truck, p_per_trip_ml, p_per_hour_ml, p_per_km_ml, p_effective_from, false, btrim(p_source_note), btrim(p_reason), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.set_purchase_price_transport(p_price uuid, p_transport_centimes bigint, p_source_note text, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('set_purchase_price_transport');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'set_purchase_price_transport: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_price p WHERE p.id = p_price) THEN
    RAISE EXCEPTION 'set_purchase_price_transport: unknown purchase price' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.purchase_price_transport (id, purchase_price_id, transport_centimes, is_assumption, source_note, reason, created_by)
  VALUES (v_id, p_price, p_transport_centimes, false, btrim(p_source_note), btrim(p_reason), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Reads: owner and app_admin only.
CREATE FUNCTION public.cost_rates_list()
  RETURNS TABLE(o_id uuid, o_key text, o_unit text, o_value_centimes bigint, o_effective_from date, o_plant_id uuid, o_plant_code text, o_is_assumption boolean, o_source_note text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('cost_rates_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'cost_rates_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT r.id, r.rate_key, r.unit, r.value_centimes, r.effective_from, r.plant_id, p.code, r.is_assumption, r.source_note
    FROM public.cost_rate r LEFT JOIN public.plant p ON p.id = r.plant_id
   ORDER BY r.rate_key, p.code NULLS FIRST, r.effective_from DESC;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.fuel_norms_list()
  RETURNS TABLE(o_id uuid, o_truck_kind text, o_truck_id uuid, o_truck_code text, o_per_trip_ml bigint, o_per_hour_ml bigint, o_per_km_ml bigint, o_effective_from date, o_is_assumption boolean, o_source_note text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('fuel_norms_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'fuel_norms_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT n.id, n.truck_kind, n.truck_id, t.code, n.per_trip_ml, n.per_hour_ml, n.per_km_ml, n.effective_from, n.is_assumption, n.source_note
    FROM public.fuel_norm n LEFT JOIN public.truck t ON t.id = n.truck_id
   ORDER BY coalesce(n.truck_kind, 'z'), t.code NULLS FIRST, n.effective_from DESC;
END $$;
--> statement-breakpoint
-- Every purchase price with its LATEST transport row (NULL = transport not recorded), so the screen can show and replace the delivered price.
CREATE FUNCTION public.purchase_transports_list()
  RETURNS TABLE(o_price_id uuid, o_component_code text, o_component_name text, o_unit_label text, o_price_centimes bigint, o_effective_from date, o_transport_centimes bigint, o_transport_is_assumption boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('purchase_transports_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'purchase_transports_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p.id, c.code, c.name_fr, u.label, p.price_ht_centimes, p.effective_from, x.transport_centimes, x.is_assumption
    FROM public.purchase_price p
    JOIN public.component c ON c.id = p.component_id
    JOIN public.purchase_unit u ON u.id = p.purchase_unit_id
    LEFT JOIN LATERAL (SELECT t.transport_centimes, t.is_assumption FROM public.purchase_price_transport t
                        WHERE t.purchase_price_id = p.id ORDER BY t.created_at DESC, t.id DESC LIMIT 1) x ON true
   ORDER BY c.code, p.effective_from DESC;
END $$;
--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.set_cost_rate(text, bigint, date, uuid, text, text)',
                           'public.set_fuel_norm(text, uuid, bigint, bigint, bigint, date, text, text)',
                           'public.set_purchase_price_transport(uuid, bigint, text, text)',
                           'public.cost_rates_list()', 'public.fuel_norms_list()', 'public.purchase_transports_list()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
