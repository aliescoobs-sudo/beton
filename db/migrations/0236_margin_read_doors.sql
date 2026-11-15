-- T17 G9 (SPEC-cost-margin §6, §9, §10, §15; D239 to D243): the margin read side and the pump-job flag of the snapshot. No data (decision 79). Forward migration.
--   write_bl_cost_snapshot (replaces 0234's body): a POMPE BL with no pump job that day for its client at its plant (or a pump of no plant) costs NO pump block and is flagged 'pump_job_missing' (D243).
--     That key is a missing key, so the snapshot is INCOMPLETE and is counted and listed apart by the margin doors. Existing snapshots are unchanged (insert-only).
--   bl_margin_list, margin_summary: owner and app_admin only, actor first, SECURITY DEFINER, read the frozen snapshot only.
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
    -- D243: a POMPE BL with no pump job (that day, that client, a pump of the order's plant or of no plant) costs no pump block and says so
    IF NOT EXISTS (SELECT 1 FROM public.pump_job j JOIN public.truck pt ON pt.id = j.pump_id
                    WHERE j.job_date = NEW.load_date AND j.client_id = v_order.client_id AND (pt.plant_id IS NULL OR pt.plant_id = v_order.plant_id)) THEN
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

-- The margin read doors (owner and app_admin only; actor first). Figures come from the frozen snapshot and the BL's own sale price (the order's unit price HT x the BL litres, one rounding, the way an invoice line
-- is made); the three margins are SPEC-cost-margin §6: M1 = price - materials; M2 = price - materials - delivery - pump; M3 = price - the five blocks. A cancelled BL has a reversing snapshot of the exact negation,
-- so a cancelled load nets to zero. An INCOMPLETE snapshot (a missing rate, price, norm, discharge method or pump job) is never summed with zero costs: the summary counts it and the list shows it apart.
-- A BL with no method is its own line ('NONE'), never counted as GOULOTTE. The counts are net of cancellations (an original counts +1, its reversing snapshot -1).
CREATE FUNCTION public.bl_margin_list(p_from date, p_to date, p_plant uuid, p_class uuid, p_method text, p_client uuid, p_scope text, p_limit integer)
  RETURNS TABLE(o_snapshot_id uuid, o_bl_no text, o_load_date date, o_plant_code text, o_class_code text, o_method text, o_client_code text, o_client_name text, o_volume_l bigint, o_is_reversal boolean,
                o_price_centimes bigint, o_materials_centimes bigint, o_delivery_centimes bigint, o_pump_centimes bigint, o_plant_centimes bigint, o_overheads_centimes bigint, o_total_cost_centimes bigint,
                o_m1_centimes bigint, o_m2_centimes bigint, o_m3_centimes bigint, o_incomplete boolean, o_missing_keys text[], o_uses_assumption boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('bl_margin_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'bl_margin_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_method IS NOT NULL AND p_method <> ALL (ARRAY['GOULOTTE', 'POMPE', 'NONE']) THEN
    RAISE EXCEPTION 'bl_margin_list: the method filter is GOULOTTE, POMPE or NONE' USING ERRCODE = 'check_violation';
  END IF;
  IF p_scope IS NULL OR p_scope <> ALL (ARRAY['all', 'complete', 'incomplete']) THEN
    RAISE EXCEPTION 'bl_margin_list: the scope is all, complete or incomplete' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  SELECT s.id, d.bl_no, s.load_date, pl.code, t.code, s.discharge_method, c.code, c.name, s.volume_l::bigint, (s.reverses_id IS NOT NULL),
         public.scale_qty(o.unit_price_ht_centimes, s.volume_l, 1000),
         s.materials_centimes, s.delivery_centimes, s.pump_centimes, s.plant_centimes, s.overheads_centimes, s.total_cost_centimes,
         public.scale_qty(o.unit_price_ht_centimes, s.volume_l, 1000) - s.materials_centimes,
         public.scale_qty(o.unit_price_ht_centimes, s.volume_l, 1000) - s.materials_centimes - s.delivery_centimes - s.pump_centimes,
         public.scale_qty(o.unit_price_ht_centimes, s.volume_l, 1000) - s.total_cost_centimes,
         s.incomplete, s.missing_keys, s.uses_assumption
    FROM public.bl_cost_snapshot s
    JOIN public.delivery d ON d.id = s.delivery_id
    JOIN public.sales_order o ON o.id = d.order_id
    JOIN public.client c ON c.id = o.client_id
    JOIN public.concrete_type t ON t.id = s.concrete_type_id
    LEFT JOIN public.plant pl ON pl.id = s.plant_id
   WHERE (p_from IS NULL OR s.load_date >= p_from) AND (p_to IS NULL OR s.load_date <= p_to)
     AND (p_plant IS NULL OR s.plant_id = p_plant) AND (p_class IS NULL OR s.concrete_type_id = p_class) AND (p_client IS NULL OR o.client_id = p_client)
     AND (p_method IS NULL OR (p_method = 'NONE' AND s.discharge_method IS NULL) OR s.discharge_method = p_method)
     AND (p_scope = 'all' OR (p_scope = 'incomplete') = s.incomplete)
   ORDER BY s.load_date DESC, d.bl_no DESC, s.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 500), 2000));
END $$;
--> statement-breakpoint
CREATE FUNCTION public.margin_summary(p_group text, p_from date, p_to date, p_plant uuid, p_class uuid, p_method text, p_client uuid)
  RETURNS TABLE(o_key text, o_label text, o_is_total boolean, o_bl_count bigint, o_volume_l bigint, o_price_centimes bigint,
                o_materials_centimes bigint, o_delivery_centimes bigint, o_pump_centimes bigint, o_plant_centimes bigint, o_overheads_centimes bigint, o_total_cost_centimes bigint,
                o_m1_centimes bigint, o_m2_centimes bigint, o_m3_centimes bigint, o_m1_bp integer, o_m2_bp integer, o_m3_bp integer,
                o_incomplete_count bigint, o_assumed_bl_count bigint, o_assumed_inputs bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('margin_summary');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'margin_summary: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_group IS NULL OR p_group <> ALL (ARRAY['month', 'plant', 'class', 'method', 'client', 'class_method']) THEN
    RAISE EXCEPTION 'margin_summary: the grouping is month, plant, class, method, client or class_method' USING ERRCODE = 'check_violation';
  END IF;
  IF p_method IS NOT NULL AND p_method <> ALL (ARRAY['GOULOTTE', 'POMPE', 'NONE']) THEN
    RAISE EXCEPTION 'margin_summary: the method filter is GOULOTTE, POMPE or NONE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  WITH base AS MATERIALIZED (
  SELECT s.id, s.reverses_id, s.incomplete, s.uses_assumption, s.volume_l::bigint vol,
         public.scale_qty(o.unit_price_ht_centimes, s.volume_l, 1000) price,
         s.materials_centimes mat, s.delivery_centimes del, s.pump_centimes pump, s.plant_centimes pln, s.overheads_centimes ovh, s.total_cost_centimes tot,
         s.diesel_rate_id, s.delivery_other_rate_id, s.pump_rate_id, s.plant_rate_id, s.overhead_rate_id, s.fuel_norm_id,
         CASE p_group WHEN 'month' THEN to_char(s.load_date, 'YYYY-MM') WHEN 'plant' THEN coalesce(pl.code, '-') WHEN 'class' THEN t.code
                      WHEN 'method' THEN coalesce(s.discharge_method, 'NONE') WHEN 'client' THEN c.code
                      ELSE t.code || '/' || coalesce(s.discharge_method, 'NONE') END AS gkey,
         CASE p_group WHEN 'client' THEN c.code || ' ' || c.name WHEN 'plant' THEN coalesce(pl.code, '-') ELSE NULL END AS glabel
    FROM public.bl_cost_snapshot s
    JOIN public.delivery d ON d.id = s.delivery_id
    JOIN public.sales_order o ON o.id = d.order_id
    JOIN public.client c ON c.id = o.client_id
    JOIN public.concrete_type t ON t.id = s.concrete_type_id
    LEFT JOIN public.plant pl ON pl.id = s.plant_id
   WHERE (p_from IS NULL OR s.load_date >= p_from) AND (p_to IS NULL OR s.load_date <= p_to)
     AND (p_plant IS NULL OR s.plant_id = p_plant) AND (p_class IS NULL OR s.concrete_type_id = p_class) AND (p_client IS NULL OR o.client_id = p_client)
     AND (p_method IS NULL OR (p_method = 'NONE' AND s.discharge_method IS NULL) OR s.discharge_method = p_method)
  ), inputs AS (
    SELECT count(DISTINCT x.id) AS n FROM (
    SELECT r.id FROM base b JOIN public.cost_rate r ON r.id IN (b.diesel_rate_id, b.delivery_other_rate_id, b.pump_rate_id, b.plant_rate_id, b.overhead_rate_id) WHERE r.is_assumption
    UNION
    SELECT n.id FROM base b JOIN public.fuel_norm n ON n.id = b.fuel_norm_id WHERE n.is_assumption
    UNION
    SELECT l.purchase_price_id FROM base b JOIN public.bl_cost_snapshot_line l ON l.snapshot_id = b.id WHERE l.uses_assumption AND l.purchase_price_id IS NOT NULL
    ) x
  ), agg AS (
    SELECT b.gkey, max(b.glabel) glabel, false AS tot_row,
           coalesce(sum(CASE WHEN b.reverses_id IS NULL THEN 1 ELSE -1 END) FILTER (WHERE NOT b.incomplete), 0)::bigint blc,
           coalesce(sum(b.vol) FILTER (WHERE NOT b.incomplete), 0)::bigint vol,
           coalesce(sum(b.price) FILTER (WHERE NOT b.incomplete), 0)::bigint price,
           coalesce(sum(b.mat) FILTER (WHERE NOT b.incomplete), 0)::bigint mat, coalesce(sum(b.del) FILTER (WHERE NOT b.incomplete), 0)::bigint del,
           coalesce(sum(b.pump) FILTER (WHERE NOT b.incomplete), 0)::bigint pump, coalesce(sum(b.pln) FILTER (WHERE NOT b.incomplete), 0)::bigint pln,
           coalesce(sum(b.ovh) FILTER (WHERE NOT b.incomplete), 0)::bigint ovh, coalesce(sum(b.tot) FILTER (WHERE NOT b.incomplete), 0)::bigint tot,
           coalesce(sum(CASE WHEN b.reverses_id IS NULL THEN 1 ELSE -1 END) FILTER (WHERE b.incomplete), 0)::bigint inc,
           coalesce(sum(CASE WHEN b.reverses_id IS NULL THEN 1 ELSE -1 END) FILTER (WHERE NOT b.incomplete AND b.uses_assumption), 0)::bigint asm
      FROM base b GROUP BY b.gkey
    UNION ALL
    SELECT 'TOTAL', NULL, true,
           coalesce(sum(CASE WHEN b.reverses_id IS NULL THEN 1 ELSE -1 END) FILTER (WHERE NOT b.incomplete), 0)::bigint,
           coalesce(sum(b.vol) FILTER (WHERE NOT b.incomplete), 0)::bigint, coalesce(sum(b.price) FILTER (WHERE NOT b.incomplete), 0)::bigint,
           coalesce(sum(b.mat) FILTER (WHERE NOT b.incomplete), 0)::bigint, coalesce(sum(b.del) FILTER (WHERE NOT b.incomplete), 0)::bigint,
           coalesce(sum(b.pump) FILTER (WHERE NOT b.incomplete), 0)::bigint, coalesce(sum(b.pln) FILTER (WHERE NOT b.incomplete), 0)::bigint,
           coalesce(sum(b.ovh) FILTER (WHERE NOT b.incomplete), 0)::bigint, coalesce(sum(b.tot) FILTER (WHERE NOT b.incomplete), 0)::bigint,
           coalesce(sum(CASE WHEN b.reverses_id IS NULL THEN 1 ELSE -1 END) FILTER (WHERE b.incomplete), 0)::bigint,
           coalesce(sum(CASE WHEN b.reverses_id IS NULL THEN 1 ELSE -1 END) FILTER (WHERE NOT b.incomplete AND b.uses_assumption), 0)::bigint
      FROM base b
  )
  SELECT a.gkey, coalesce(a.glabel, a.gkey), a.tot_row, a.blc, a.vol, a.price, a.mat, a.del, a.pump, a.pln, a.ovh, a.tot,
         a.price - a.mat, a.price - a.mat - a.del - a.pump, a.price - a.tot,
         CASE WHEN a.price > 0 THEN public._mul_div_round((a.price - a.mat)::numeric * 10000, a.price)::integer END,
         CASE WHEN a.price > 0 THEN public._mul_div_round((a.price - a.mat - a.del - a.pump)::numeric * 10000, a.price)::integer END,
         CASE WHEN a.price > 0 THEN public._mul_div_round((a.price - a.tot)::numeric * 10000, a.price)::integer END,
         a.inc, a.asm, CASE WHEN a.tot_row THEN (SELECT n FROM inputs) ELSE 0::bigint END
    FROM agg a ORDER BY a.tot_row, a.gkey;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.bl_margin_list(date, date, uuid, uuid, text, uuid, text, integer)', 'public.margin_summary(text, date, date, uuid, uuid, text, uuid)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
