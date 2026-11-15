-- T17 G10 (SPEC-cost-margin §15; D243): the pump check, and the one definition of "a pump job for this BL".
--   public._pump_matches(...)   a pump job serves a BL when it is the BL's day, its plant is the BL's (a NULL plant on either side is compatible), and it is the BL's order, or its client (the job's own, else its order's),
--                               or it names neither. The snapshot (D243) and the pump check use this ONE definition. Replaces the first rule of 0236 (a pump truck's plant: a pump truck has no plant, truck_pump_no_plant).
--   write_bl_cost_snapshot      replaced again (same body as 0236) with that definition.
--   pump_check(from, to, plant) per day and plant: (a) POMPE BLs with no pump job, (b) pump jobs with no POMPE BL, (c) GOULOTTE BLs on a day and plant where a pump job exists for the same client.
--                               Owner and app_admin (every plant), the plant manager of THAT plant only (his bound plant, never a parameter; the whole tuple: the BL's order AND the BL AND the job AND the job's order
--                               are all of his plant; a plant manager bound to no plant is refused). Cancelled BLs and BLs with no method recorded are not counted. NO cost figure in it.
-- No data (decision 79). Forward migration.
CREATE FUNCTION public._pump_matches(p_job_date date, p_job_plant uuid, p_job_client uuid, p_job_order uuid, p_load_date date, p_plant uuid, p_client uuid, p_order uuid)
  RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_job_date = p_load_date
     AND (p_job_plant IS NULL OR p_plant IS NULL OR p_job_plant = p_plant)
     AND (p_job_order = p_order OR p_job_client = p_client OR (p_job_order IS NULL AND p_job_client IS NULL))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._pump_matches(date, uuid, uuid, uuid, date, uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.write_bl_cost_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
  v_nopump  boolean := false;
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
    -- D243: a POMPE BL with no pump job (that day, its order or its client, the order's plant or no plant: public._pump_matches) costs no pump block and says so
    IF NOT EXISTS (SELECT 1 FROM public.pump_job j LEFT JOIN public.sales_order jo ON jo.id = j.order_id
                    WHERE public._pump_matches(j.job_date, j.plant_id, coalesce(j.client_id, jo.client_id), j.order_id, NEW.load_date, v_order.plant_id, v_order.client_id, NEW.order_id)) THEN
      v_nopump := true;
      v_missing := array_append(v_missing, 'pump_job_missing');
    END IF;
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
  IF v_prate.id IS NOT NULL AND NOT v_nopump THEN v_pump := public._mul_div_round(v_prate.value_centimes::numeric * NEW.volume_l, 1000); END IF;
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
CREATE FUNCTION public.pump_check(p_from date, p_to date, p_plant uuid)
  RETURNS TABLE(o_kind text, o_day date, o_plant_id uuid, o_plant_code text, o_client_code text, o_client_name text, o_bl_no text, o_job_id uuid, o_site_label text, o_volume_l bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text;
  v_scope uuid;
  v_plant uuid;
BEGIN
  v_role := ctx.require_admitted_actor('pump_check');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'plant_manager']) THEN
    RAISE EXCEPTION 'pump_check: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role = 'plant_manager' THEN
    v_scope := ctx.plant_scope();
    IF v_scope IS NULL THEN
      RAISE EXCEPTION 'pump_check: no plant' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_plant := v_scope;
  ELSE
    v_plant := p_plant;
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN
    RAISE EXCEPTION 'pump_check: a period of at most 93 days is needed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  WITH bl AS (
    SELECT d.id, d.bl_no, d.load_date, d.volume_l, d.discharge_method AS method, d.plant_id AS d_plant, o.id AS order_id, o.client_id, o.plant_id
      FROM public.delivery d JOIN public.sales_order o ON o.id = d.order_id
     WHERE d.reverses_id IS NULL AND d.discharge_method IS NOT NULL AND d.load_date BETWEEN p_from AND p_to
       AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
  ), jobs AS (
    SELECT j.id, j.job_date, j.plant_id, coalesce(j.client_id, jo.client_id) AS client_id, j.order_id, j.site_label, j.planned_m3, jo.plant_id AS order_plant
      FROM public.pump_job j LEFT JOIN public.sales_order jo ON jo.id = j.order_id
     WHERE j.job_date BETWEEN p_from AND p_to
  ), rows_a AS (
    SELECT 'pompe_bl_no_job'::text AS kind, b.load_date AS day, b.plant_id AS plant, b.client_id, b.bl_no, NULL::uuid AS job_id, NULL::text AS site, b.volume_l::bigint AS vol
      FROM bl b
     WHERE b.method = 'POMPE' AND (v_plant IS NULL OR b.plant_id = v_plant) AND (v_scope IS NULL OR b.d_plant = v_scope)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE public._pump_matches(j.job_date, j.plant_id, j.client_id, j.order_id, b.load_date, b.plant_id, b.client_id, b.order_id))
  ), rows_b AS (
    SELECT 'job_no_pompe_bl'::text, j.job_date, j.plant_id, j.client_id, NULL::text, j.id, j.site_label, (j.planned_m3 * 1000)::bigint
      FROM jobs j
     WHERE (v_plant IS NULL OR j.plant_id = v_plant) AND (v_scope IS NULL OR (j.plant_id = v_scope AND (j.order_id IS NULL OR j.order_plant = v_scope)))
       AND NOT EXISTS (SELECT 1 FROM bl b WHERE b.method = 'POMPE' AND public._pump_matches(j.job_date, j.plant_id, j.client_id, j.order_id, b.load_date, b.plant_id, b.client_id, b.order_id))
  ), rows_c AS (
    SELECT 'goulotte_bl_with_job'::text, b.load_date, b.plant_id, b.client_id, b.bl_no, NULL::uuid, NULL::text, b.volume_l::bigint
      FROM bl b
     WHERE b.method = 'GOULOTTE' AND (v_plant IS NULL OR b.plant_id = v_plant) AND (v_scope IS NULL OR b.d_plant = v_scope)
       AND EXISTS (SELECT 1 FROM jobs j WHERE j.job_date = b.load_date AND j.client_id = b.client_id AND (j.plant_id IS NULL OR b.plant_id IS NULL OR j.plant_id = b.plant_id))
  )
  SELECT x.kind, x.day, x.plant, pl.code, c.code, c.name, x.bl_no, x.job_id, x.site, x.vol
    FROM (SELECT * FROM rows_a UNION ALL SELECT * FROM rows_b UNION ALL SELECT * FROM rows_c) x
    LEFT JOIN public.plant pl ON pl.id = x.plant
    LEFT JOIN public.client c ON c.id = x.client_id
   ORDER BY x.day DESC, pl.code NULLS LAST, x.kind, x.bl_no;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.pump_check(date, date, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.pump_check(date, date, uuid) TO belgobeton_app;
