-- T16 G6 (SPEC-cost-margin §5, §7, §15; D236, D237): the cost snapshot of a BL. WRITTEN INSIDE THE BL's OWN TRANSACTION, by an AFTER INSERT trigger on delivery (a SECURITY DEFINER function), so every
-- way a BL is created (the plant screen, the field door, the pilot scenario, a cancellation) is covered and none can skip it; the BL is never refused because a rate is missing.
--   bl_cost_snapshot       one row per BL row, insert-only: the recette version, the discharge method, the class, the invoiced volume (signed), the version id and value of every rate used, the fuel norm and the
--                          diesel price, and the five cost blocks in integer centimes (materials, delivery, pump, plant, overheads). Missing inputs are LISTED (missing_keys) and flip `incomplete`; they are never
--                          replaced by a silent fallback (a missing rate costs 0 and says so). `uses_assumption` says whether any input is flagged is_assumption (a purchase price made by the system actor is the seed).
--   bl_cost_snapshot_line  one row per recette line: the dose, the rounded quantity, the purchase price (and its version id), the transport (and its id), the cost of the line.
--   A cancelled load writes a REVERSING snapshot (the exact negation of the original, linked to it); nothing is ever updated or deleted. A cancellation of a BL older than this migration has no
--   snapshot to reverse and writes none.
-- Arithmetic: integers only (numeric for the product, which is exact), ONE rounding per line, half away from zero (public._mul_div_round); the five blocks are sums of rounded lines. AI never computes money.
-- Access: doors-only like 0232/0233. The plant manager who creates the BL triggers the snapshot (the trigger runs as the definer) and can read nothing back: the application and system logins hold no
-- privilege on the tables. The margin read doors and the "Marges" screen are T17.
-- Forward migration.
CREATE FUNCTION public._mul_div_round(p_num numeric, p_den numeric) RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_num >= 0 THEN div(2 * p_num + p_den, 2 * p_den)::bigint
              ELSE -(div(2 * (-p_num) + p_den, 2 * p_den))::bigint END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._mul_div_round(numeric, numeric) FROM PUBLIC;
--> statement-breakpoint

CREATE TABLE public.bl_cost_snapshot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id     uuid NOT NULL UNIQUE REFERENCES public.delivery (id),
  reverses_id     uuid UNIQUE REFERENCES public.bl_cost_snapshot (id),
  concrete_type_id uuid NOT NULL REFERENCES public.concrete_type (id),
  plant_id        uuid REFERENCES public.plant (id),
  discharge_method text CHECK (discharge_method IN ('GOULOTTE', 'POMPE')),
  load_date       date NOT NULL,
  -- litres invoiced with the BL; negative on a reversing snapshot
  volume_l        integer NOT NULL CHECK (volume_l <> 0),
  recette_id      uuid NOT NULL REFERENCES public.recette (id),
  recette_version integer NOT NULL,
  -- what the mapping says the plant should batch for this class and method (information only: the BL's own recette is what was consumed)
  mapped_recette_id uuid REFERENCES public.recette (id),
  diesel_rate_id  uuid REFERENCES public.cost_rate (id),
  diesel_centimes_per_l bigint,
  fuel_norm_id    uuid REFERENCES public.fuel_norm (id),
  trip_fuel_ml    bigint,
  delivery_other_rate_id uuid REFERENCES public.cost_rate (id),
  delivery_other_centimes_per_m3 bigint,
  pump_rate_id    uuid REFERENCES public.cost_rate (id),
  pump_centimes_per_m3 bigint,
  plant_rate_id   uuid REFERENCES public.cost_rate (id),
  plant_centimes_per_m3 bigint,
  overhead_rate_id uuid REFERENCES public.cost_rate (id),
  overhead_centimes_per_m3 bigint,
  materials_centimes bigint NOT NULL,
  delivery_centimes  bigint NOT NULL,
  pump_centimes      bigint NOT NULL,
  plant_centimes     bigint NOT NULL,
  overheads_centimes bigint NOT NULL,
  total_cost_centimes bigint NOT NULL,
  incomplete      boolean NOT NULL,
  missing_keys    text[] NOT NULL DEFAULT '{}',
  uses_assumption boolean NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (total_cost_centimes = materials_centimes + delivery_centimes + pump_centimes + plant_centimes + overheads_centimes),
  CHECK (incomplete = (cardinality(missing_keys) > 0)),
  CHECK ((reverses_id IS NULL) = (volume_l > 0))
);
--> statement-breakpoint
CREATE TABLE public.bl_cost_snapshot_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id   uuid NOT NULL REFERENCES public.bl_cost_snapshot (id),
  component_id  uuid NOT NULL REFERENCES public.component (id),
  -- base units of the component per m3 (the dose of the recette line) and the rounded quantity of the load (signed)
  qty_per_m3    bigint NOT NULL,
  qty_base      bigint NOT NULL,
  purchase_price_id uuid REFERENCES public.purchase_price (id),
  price_centimes bigint,
  factor_to_base bigint,
  transport_id  uuid REFERENCES public.purchase_price_transport (id),
  transport_centimes bigint,
  line_centimes bigint NOT NULL,
  uses_assumption boolean NOT NULL,
  UNIQUE (snapshot_id, component_id)
);
--> statement-breakpoint
CREATE INDEX bl_cost_snapshot_class_idx ON public.bl_cost_snapshot (concrete_type_id, discharge_method, load_date);
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bl_cost_snapshot', 'bl_cost_snapshot_line'] LOOP
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

CREATE FUNCTION public.write_bl_cost_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order   public.sales_order%ROWTYPE;
  v_truck   public.truck%ROWTYPE;
  v_rec     public.recette%ROWTYPE;
  v_orig    public.bl_cost_snapshot%ROWTYPE;
  v_snap    uuid := gen_random_uuid();
  v_missing text[] := '{}';
  v_assumed boolean := false;
  v_mat     bigint := 0;
  v_deliv   bigint := 0;
  v_pump    bigint := 0;
  v_plant   bigint := 0;
  v_over    bigint := 0;
  v_diesel  public.cost_rate%ROWTYPE;
  v_other   public.cost_rate%ROWTYPE;
  v_prate   public.cost_rate%ROWTYPE;
  v_plrate  public.cost_rate%ROWTYPE;
  v_orate   public.cost_rate%ROWTYPE;
  v_norm    public.fuel_norm%ROWTYPE;
  v_mapped  uuid;
  v_line    record;
  v_price   public.purchase_price%ROWTYPE;
  v_unit    public.purchase_unit%ROWTYPE;
  v_trans   public.purchase_price_transport%ROWTYPE;
  v_lc      bigint;
  v_n       integer := 0;
  v_cmp     text;
  v_lines   jsonb := '[]'::jsonb;
  v_flag    boolean;
BEGIN
  -- a cancellation: the exact negation of the original snapshot, linked to it
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.bl_cost_snapshot s WHERE s.delivery_id = NEW.reverses_id AND s.reverses_id IS NULL;
    IF NOT FOUND THEN RETURN NEW; END IF;
    INSERT INTO public.bl_cost_snapshot (id, delivery_id, reverses_id, concrete_type_id, plant_id, discharge_method, load_date, volume_l, recette_id, recette_version, mapped_recette_id,
        diesel_rate_id, diesel_centimes_per_l, fuel_norm_id, trip_fuel_ml, delivery_other_rate_id, delivery_other_centimes_per_m3, pump_rate_id, pump_centimes_per_m3,
        plant_rate_id, plant_centimes_per_m3, overhead_rate_id, overhead_centimes_per_m3,
        materials_centimes, delivery_centimes, pump_centimes, plant_centimes, overheads_centimes, total_cost_centimes, incomplete, missing_keys, uses_assumption, created_by)
    VALUES (v_snap, NEW.id, v_orig.id, v_orig.concrete_type_id, v_orig.plant_id, v_orig.discharge_method, NEW.load_date, -v_orig.volume_l, v_orig.recette_id, v_orig.recette_version, v_orig.mapped_recette_id,
        v_orig.diesel_rate_id, v_orig.diesel_centimes_per_l, v_orig.fuel_norm_id, v_orig.trip_fuel_ml, v_orig.delivery_other_rate_id, v_orig.delivery_other_centimes_per_m3, v_orig.pump_rate_id, v_orig.pump_centimes_per_m3,
        v_orig.plant_rate_id, v_orig.plant_centimes_per_m3, v_orig.overhead_rate_id, v_orig.overhead_centimes_per_m3,
        -v_orig.materials_centimes, -v_orig.delivery_centimes, -v_orig.pump_centimes, -v_orig.plant_centimes, -v_orig.overheads_centimes, -v_orig.total_cost_centimes,
        v_orig.incomplete, v_orig.missing_keys, v_orig.uses_assumption, NEW.created_by);
    INSERT INTO public.bl_cost_snapshot_line (snapshot_id, component_id, qty_per_m3, qty_base, purchase_price_id, price_centimes, factor_to_base, transport_id, transport_centimes, line_centimes, uses_assumption)
    SELECT v_snap, l.component_id, l.qty_per_m3, -l.qty_base, l.purchase_price_id, l.price_centimes, l.factor_to_base, l.transport_id, l.transport_centimes, -l.line_centimes, l.uses_assumption
      FROM public.bl_cost_snapshot_line l WHERE l.snapshot_id = v_orig.id;
    RETURN NEW;
  END IF;

  SELECT * INTO v_order FROM public.sales_order o WHERE o.id = NEW.order_id;
  SELECT * INTO v_truck FROM public.truck t WHERE t.id = NEW.truck_id;
  SELECT * INTO v_rec FROM public.recette r WHERE r.id = NEW.recette_id;
  IF NEW.discharge_method IS NULL THEN v_missing := array_append(v_missing, 'discharge_method'); END IF;
  SELECT m.recette_id INTO v_mapped FROM public._class_method_recette_in_force(v_order.concrete_type_id, NEW.discharge_method, v_order.plant_id, NEW.load_date) m;

  -- the rates in force on the load date; the plant's own wins over the all-plants one
  SELECT * INTO v_diesel FROM public.cost_rate r WHERE r.rate_key = 'diesel_per_l' AND r.effective_from <= NEW.load_date AND (r.plant_id IS NULL OR r.plant_id = v_order.plant_id)
   ORDER BY (r.plant_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1;
  IF NOT FOUND THEN v_missing := array_append(v_missing, 'rate:diesel_per_l'); END IF;
  SELECT * INTO v_other FROM public.cost_rate r WHERE r.rate_key = 'delivery_other_per_m3' AND r.effective_from <= NEW.load_date AND (r.plant_id IS NULL OR r.plant_id = v_order.plant_id)
   ORDER BY (r.plant_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1;
  IF NOT FOUND THEN v_missing := array_append(v_missing, 'rate:delivery_other_per_m3'); END IF;
  SELECT * INTO v_plrate FROM public.cost_rate r WHERE r.rate_key = 'plant_per_m3' AND r.effective_from <= NEW.load_date AND (r.plant_id IS NULL OR r.plant_id = v_order.plant_id)
   ORDER BY (r.plant_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1;
  IF NOT FOUND THEN v_missing := array_append(v_missing, 'rate:plant_per_m3'); END IF;
  SELECT * INTO v_orate FROM public.cost_rate r WHERE r.rate_key = 'overhead_per_m3' AND r.effective_from <= NEW.load_date AND (r.plant_id IS NULL OR r.plant_id = v_order.plant_id)
   ORDER BY (r.plant_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1;
  IF NOT FOUND THEN v_missing := array_append(v_missing, 'rate:overhead_per_m3'); END IF;
  IF NEW.discharge_method = 'POMPE' THEN
    SELECT * INTO v_prate FROM public.cost_rate r WHERE r.rate_key = 'pump_per_m3' AND r.effective_from <= NEW.load_date AND (r.plant_id IS NULL OR r.plant_id = v_order.plant_id)
     ORDER BY (r.plant_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1;
    IF NOT FOUND THEN v_missing := array_append(v_missing, 'rate:pump_per_m3'); END IF;
  END IF;
  -- the trip fuel: the truck's own norm, else its kind's (a norm with a per-trip figure)
  SELECT * INTO v_norm FROM public.fuel_norm n WHERE n.per_trip_ml IS NOT NULL AND n.effective_from <= NEW.load_date AND (n.truck_id = NEW.truck_id OR (n.truck_id IS NULL AND n.truck_kind = v_truck.kind))
   ORDER BY (n.truck_id IS NOT NULL) DESC, n.effective_from DESC LIMIT 1;
  IF NOT FOUND THEN v_missing := array_append(v_missing, 'fuel_norm:' || v_truck.kind); END IF;

  -- the five blocks; each element is rounded once, half away from zero
  IF v_diesel.id IS NOT NULL AND v_norm.id IS NOT NULL THEN
    v_deliv := v_deliv + public._mul_div_round(v_norm.per_trip_ml::numeric * v_diesel.value_centimes, 1000);
  END IF;
  IF v_other.id IS NOT NULL THEN v_deliv := v_deliv + public._mul_div_round(v_other.value_centimes::numeric * NEW.volume_l, 1000); END IF;
  IF v_prate.id IS NOT NULL THEN v_pump := public._mul_div_round(v_prate.value_centimes::numeric * NEW.volume_l, 1000); END IF;
  IF v_plrate.id IS NOT NULL THEN v_plant := public._mul_div_round(v_plrate.value_centimes::numeric * NEW.volume_l, 1000); END IF;
  IF v_orate.id IS NOT NULL THEN v_over := public._mul_div_round(v_orate.value_centimes::numeric * NEW.volume_l, 1000); END IF;
  v_assumed := coalesce(v_diesel.is_assumption, false) OR coalesce(v_other.is_assumption, false) OR coalesce(v_prate.is_assumption, false)
            OR coalesce(v_plrate.is_assumption, false) OR coalesce(v_orate.is_assumption, false) OR coalesce(v_norm.is_assumption, false);

  -- the materials: one line per recette line, ONE rounding per line: dose x litres x delivered price per purchase unit / (1000 litres per m3 x base units per purchase unit)
  FOR v_line IN SELECT l.component_id, l.qty_per_m3 FROM public.recette_line l WHERE l.recette_id = NEW.recette_id ORDER BY l.component_id LOOP
    v_n := v_n + 1;
    SELECT c.code INTO v_cmp FROM public.component c WHERE c.id = v_line.component_id;
    v_price := NULL; v_unit := NULL; v_trans := NULL; v_lc := 0;
    SELECT * INTO v_price FROM public.purchase_price p WHERE p.component_id = v_line.component_id AND p.effective_from <= NEW.load_date ORDER BY p.effective_from DESC LIMIT 1;
    IF FOUND THEN
      SELECT * INTO v_unit FROM public.purchase_unit u WHERE u.id = v_price.purchase_unit_id;
      SELECT * INTO v_trans FROM public.purchase_price_transport x WHERE x.purchase_price_id = v_price.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1;
      IF NOT FOUND THEN v_missing := array_append(v_missing, 'transport:' || v_cmp); END IF;
      v_lc := public._mul_div_round(v_line.qty_per_m3::numeric * NEW.volume_l * (v_price.price_ht_centimes + coalesce(v_trans.transport_centimes, 0)), 1000::numeric * v_unit.factor_to_base);
    ELSE
      v_missing := array_append(v_missing, 'price:' || v_cmp);
    END IF;
    v_flag := coalesce(v_trans.is_assumption, false) OR coalesce(v_price.created_by = '00000000-0000-7000-8000-000000000002'::uuid, false);
    v_assumed := v_assumed OR v_flag;
    v_lines := v_lines || jsonb_build_object('component_id', v_line.component_id, 'qty_per_m3', v_line.qty_per_m3,
        'qty_base', public.scale_qty(v_line.qty_per_m3, NEW.volume_l, 1000), 'purchase_price_id', v_price.id, 'price_centimes', v_price.price_ht_centimes,
        'factor_to_base', v_unit.factor_to_base, 'transport_id', v_trans.id, 'transport_centimes', v_trans.transport_centimes, 'line_centimes', v_lc, 'uses_assumption', v_flag);
    v_mat := v_mat + v_lc;
  END LOOP;
  IF v_n = 0 THEN v_missing := array_append(v_missing, 'recette_lines'); END IF;

  INSERT INTO public.bl_cost_snapshot (id, delivery_id, concrete_type_id, plant_id, discharge_method, load_date, volume_l, recette_id, recette_version, mapped_recette_id,
      diesel_rate_id, diesel_centimes_per_l, fuel_norm_id, trip_fuel_ml, delivery_other_rate_id, delivery_other_centimes_per_m3, pump_rate_id, pump_centimes_per_m3,
      plant_rate_id, plant_centimes_per_m3, overhead_rate_id, overhead_centimes_per_m3,
      materials_centimes, delivery_centimes, pump_centimes, plant_centimes, overheads_centimes, total_cost_centimes, incomplete, missing_keys, uses_assumption, created_by)
  VALUES (v_snap, NEW.id, v_order.concrete_type_id, v_order.plant_id, NEW.discharge_method, NEW.load_date, NEW.volume_l, NEW.recette_id, v_rec.version, v_mapped,
      v_diesel.id, v_diesel.value_centimes, v_norm.id, v_norm.per_trip_ml, v_other.id, v_other.value_centimes, v_prate.id, v_prate.value_centimes,
      v_plrate.id, v_plrate.value_centimes, v_orate.id, v_orate.value_centimes,
      v_mat, v_deliv, v_pump, v_plant, v_over, v_mat + v_deliv + v_pump + v_plant + v_over, cardinality(v_missing) > 0, v_missing, v_assumed, NEW.created_by);
  INSERT INTO public.bl_cost_snapshot_line (snapshot_id, component_id, qty_per_m3, qty_base, purchase_price_id, price_centimes, factor_to_base, transport_id, transport_centimes, line_centimes, uses_assumption)
  SELECT v_snap, x.component_id, x.qty_per_m3, x.qty_base, x.purchase_price_id, x.price_centimes, x.factor_to_base, x.transport_id, x.transport_centimes, x.line_centimes, x.uses_assumption
    FROM jsonb_to_recordset(v_lines) AS x(component_id uuid, qty_per_m3 bigint, qty_base bigint, purchase_price_id uuid, price_centimes bigint, factor_to_base bigint,
                                          transport_id uuid, transport_centimes bigint, line_centimes bigint, uses_assumption boolean);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER write_bl_cost_snapshot AFTER INSERT ON public.delivery FOR EACH ROW EXECUTE FUNCTION public.write_bl_cost_snapshot();
