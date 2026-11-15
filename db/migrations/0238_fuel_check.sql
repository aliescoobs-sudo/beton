-- T17 G11 (SPEC-cost-margin §8; D237): the fuel check, measured against the norm, per truck and month, and its editable threshold. No data (decision 79). Forward migration.
--   cost_rate gains ONE key, 'fuel_variance_threshold_bp' (unit 'bp'; the value column holds basis points of the expected litres, 1000 = 10 %). It is versioned, flagged is_assumption, written by set_cost_rate
--   (owner, app_admin, a typed reason, audited) like every rate, so the owner edits it on /costs and a real value replaces the assumed one with a new row. The A1 default (10 %) is in the pilot seed, not here.
--   set_cost_rate    replaced: the unit follows the key; the threshold is 1 to 10 000 bp.
--   fuel_check       owner and app_admin only, actor first: per truck and month, the expected litres (the frozen per-trip norm of each live BL for a mixer or hauler; the per-hour norm times the pumping hours of each pump
--                    job for a pump), the measured litres (the truck's fuel fills), the variance in basis points of the expected litres, the threshold in force and the flag (measured ABOVE expected by more than the threshold).
--                    A truck-month with a trip or a job that has no norm has NO variance and no flag (its expected figure would be a part): it says how many were without a norm. Quantities and a percentage: no money.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.cost_rate'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '(rate_key|unit)' LOOP
    EXECUTE format('ALTER TABLE public.cost_rate DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE public.cost_rate
  ADD CONSTRAINT cost_rate_key_check CHECK (rate_key IN ('diesel_per_l', 'delivery_other_per_m3', 'pump_per_m3', 'plant_per_m3', 'overhead_per_m3', 'fuel_variance_threshold_bp')),
  ADD CONSTRAINT cost_rate_unit_check CHECK (unit IN ('centimes_per_l', 'centimes_per_m3', 'bp')),
  ADD CONSTRAINT cost_rate_key_unit_check CHECK ((rate_key = 'diesel_per_l') = (unit = 'centimes_per_l') AND (rate_key = 'fuel_variance_threshold_bp') = (unit = 'bp')),
  ADD CONSTRAINT cost_rate_threshold_range CHECK (rate_key <> 'fuel_variance_threshold_bp' OR value_centimes BETWEEN 1 AND 10000);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.set_cost_rate(p_key text, p_value_centimes bigint, p_effective_from date, p_plant uuid, p_source_note text, p_reason text) RETURNS uuid
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
  VALUES (v_id, p_key, CASE p_key WHEN 'diesel_per_l' THEN 'centimes_per_l' WHEN 'fuel_variance_threshold_bp' THEN 'bp' ELSE 'centimes_per_m3' END,
          p_value_centimes, p_effective_from, p_plant, false, btrim(p_source_note), btrim(p_reason), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.fuel_check(p_from date, p_to date, p_plant uuid)
  RETURNS TABLE(o_month text, o_truck_id uuid, o_truck_code text, o_truck_kind text, o_plant_code text, o_basis text, o_units integer, o_no_norm_units integer, o_fills integer,
                o_expected_ml bigint, o_measured_ml bigint, o_variance_ml bigint, o_variance_bp integer, o_threshold_bp integer, o_threshold_assumption boolean, o_flagged boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('fuel_check');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'fuel_check: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'fuel_check: a period of at most 401 days is needed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  WITH trips AS (
    -- the live BLs (not cancelled) of the period, with the per-trip norm their snapshot froze (a BL older than the snapshots has none: it counts as a trip with no norm)
    SELECT d.truck_id, to_char(d.load_date, 'YYYY-MM') AS m, 1 AS units, s.trip_fuel_ml AS exp_ml, (s.trip_fuel_ml IS NULL)::int AS no_norm
      FROM public.delivery d LEFT JOIN public.bl_cost_snapshot s ON s.delivery_id = d.id AND s.reverses_id IS NULL
     WHERE d.reverses_id IS NULL AND d.load_date BETWEEN p_from AND p_to
       AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
  ), hours AS (
    -- the pump jobs with both pumping events: the per-hour norm in force on the job day times the pumped seconds
    SELECT j.pump_id AS truck_id, to_char(j.job_date, 'YYYY-MM') AS m, 1 AS units,
           CASE WHEN nn.per_hour_ml IS NULL THEN NULL ELSE public._mul_div_round(nn.per_hour_ml::numeric * extract(epoch FROM (pe.at - ps.at))::bigint, 3600) END AS exp_ml,
           (nn.per_hour_ml IS NULL)::int AS no_norm
      FROM public.pump_job j
      JOIN public.truck t ON t.id = j.pump_id
      JOIN public.pump_job_event ps ON ps.job_id = j.id AND ps.step = 'pumping_started'
      JOIN public.pump_job_event pe ON pe.job_id = j.id AND pe.step = 'pumping_ended' AND pe.at >= ps.at
      LEFT JOIN LATERAL (
        SELECT n.per_hour_ml FROM public.fuel_norm n
         WHERE n.per_hour_ml IS NOT NULL AND n.effective_from <= j.job_date AND (n.truck_id = j.pump_id OR (n.truck_id IS NULL AND n.truck_kind = t.kind))
         ORDER BY (n.truck_id IS NOT NULL) DESC, n.effective_from DESC LIMIT 1) nn ON true
     WHERE j.job_date BETWEEN p_from AND p_to
  ), expected AS (
    SELECT u.truck_id, u.m, sum(u.units)::int AS units, sum(u.no_norm)::int AS no_norm, sum(u.exp_ml)::bigint AS exp_ml,
           CASE WHEN bool_or(u.basis = 'hours') THEN 'hours' ELSE 'trips' END AS basis
      FROM (SELECT t.*, 'trips' AS basis FROM trips t UNION ALL SELECT h.*, 'hours' FROM hours h) u GROUP BY u.truck_id, u.m
  ), fills AS (
    SELECT f.truck_id, to_char(f.filled_on, 'YYYY-MM') AS m, sum(f.litres_ml)::bigint AS ml, count(*)::int AS n
      FROM public.fuel_fill f WHERE f.filled_on BETWEEN p_from AND p_to GROUP BY f.truck_id, to_char(f.filled_on, 'YYYY-MM')
  ), joined AS (
    SELECT coalesce(e.truck_id, f.truck_id) AS truck_id, coalesce(e.m, f.m) AS m, e.basis, coalesce(e.units, 0) AS units, coalesce(e.no_norm, 0) AS no_norm, e.exp_ml,
           coalesce(f.ml, 0)::bigint AS measured, coalesce(f.n, 0) AS fills
      FROM expected e FULL JOIN fills f ON f.truck_id = e.truck_id AND f.m = e.m
  ), full_rows AS (
    SELECT j.*, t.code AS tcode, t.kind AS tkind, pl.code AS pcode, th.value_centimes AS th_bp, th.is_assumption AS th_assumed,
           -- no variance when a unit has no norm, or nothing is expected
           CASE WHEN j.no_norm = 0 AND j.exp_ml IS NOT NULL AND j.exp_ml > 0 THEN j.measured - j.exp_ml END AS var_ml
      FROM joined j
      JOIN public.truck t ON t.id = j.truck_id
      LEFT JOIN public.plant pl ON pl.id = t.plant_id
      LEFT JOIN LATERAL (
        SELECT r.value_centimes, r.is_assumption FROM public.cost_rate r
         WHERE r.rate_key = 'fuel_variance_threshold_bp' AND r.effective_from <= least(p_to, (date_trunc('month', to_date(j.m, 'YYYY-MM')) + interval '1 month - 1 day')::date)
           AND (r.plant_id IS NULL OR r.plant_id = t.plant_id)
         ORDER BY (r.plant_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1) th ON true
     WHERE (p_plant IS NULL OR t.plant_id = p_plant)
  )
  SELECT x.m, x.truck_id, x.tcode, x.tkind, x.pcode, coalesce(x.basis, 'none'), x.units, x.no_norm, x.fills,
         CASE WHEN x.no_norm = 0 THEN x.exp_ml END, x.measured, x.var_ml,
         CASE WHEN x.var_ml IS NOT NULL THEN public._mul_div_round(x.var_ml::numeric * 10000, x.exp_ml)::integer END,
         x.th_bp::integer, x.th_assumed,
         coalesce(x.var_ml IS NOT NULL AND x.th_bp IS NOT NULL AND x.var_ml > 0 AND public._mul_div_round(x.var_ml::numeric * 10000, x.exp_ml) > x.th_bp, false)
    FROM full_rows x ORDER BY x.m DESC, x.tcode;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.fuel_check(date, date, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.fuel_check(date, date, uuid) TO belgobeton_app;
