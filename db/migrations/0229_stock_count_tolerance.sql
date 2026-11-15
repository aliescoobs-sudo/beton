-- T15 G1 (SPEC-stock-engine-gaps §4, §5; D233, D237): count tolerance, the plant manager's right to propose a count, the owner's decision on a count out of tolerance.
--   stock_count_tolerance  versioned, insert-only; the most specific row in force wins (plant+component > component > plant > global); the seed is DATA flagged
--                          is_assumption (200 bp, floor 0), replaced by inserting a new row through set_stock_count_tolerance.
--   stock_count            one row per count, insert-only: counted, theoretical, variance, the ratio in basis points and the tolerance SNAPSHOT (so a later tolerance change
--                          never rewrites a count). In tolerance: the count posts its count_adjustment at once. Out of tolerance: it waits, nothing is posted.
--   stock_count_decision   insert-only, at most one per count: the owner or app_admin accepts (the adjustment posts) or rejects (recount) with a reason.
-- Doors (SECURITY DEFINER, actor-first, the plant is the manager's own and is never a parameter): propose_stock_count, decide_stock_count, set_stock_count_tolerance.
-- Stock invariant (SPEC §3): the only movement these doors write is `count_adjustment`; a loaded stage, a driver, an SMS or a GPS event never writes stock.
-- Quantities only: no price, no valuation (money never reaches a plant manager). Variance arithmetic is integer, one rounding, half away from zero.
-- Forward migration.
CREATE TABLE public.stock_count_tolerance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id      uuid REFERENCES public.plant (id),
  component_id  uuid REFERENCES public.component (id),
  tolerance_bp  integer NOT NULL CHECK (tolerance_bp BETWEEN 0 AND 10000),
  floor_qty     bigint  NOT NULL DEFAULT 0 CHECK (floor_qty >= 0),
  effective_from date   NOT NULL,
  is_assumption boolean NOT NULL DEFAULT false,
  created_by    uuid    NOT NULL,
  reason        text    NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX stock_count_tolerance_scope_idx ON public.stock_count_tolerance (component_id, plant_id, effective_from);
--> statement-breakpoint
CREATE TABLE public.stock_count (
  id             uuid PRIMARY KEY,
  plant_id       uuid   NOT NULL REFERENCES public.plant (id),
  component_id   uuid   NOT NULL REFERENCES public.component (id),
  count_date     date   NOT NULL,
  counted_qty    bigint NOT NULL CHECK (counted_qty >= 0),
  theoretical_qty bigint NOT NULL,
  variance_qty   bigint NOT NULL,
  -- NULL = "n/a" (the theoretical level was zero or negative)
  variance_bp    bigint,
  tolerance_id   uuid   NOT NULL REFERENCES public.stock_count_tolerance (id),
  tolerance_bp   integer NOT NULL,
  floor_qty      bigint NOT NULL,
  in_tolerance   boolean NOT NULL,
  status         text   NOT NULL CHECK (status IN ('in_tolerance_posted', 'pending_decision')),
  category       text   NOT NULL CHECK (category IN ('moisture', 'loss', 'returned_load', 'error', 'theft_suspicion', 'other')),
  reason         text   NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 400),
  movement_id    uuid   REFERENCES public.stock_movement (id),
  created_by     uuid   NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (variance_qty = counted_qty - theoretical_qty),
  CHECK ((status = 'in_tolerance_posted') = in_tolerance),
  -- a count that posts has its movement unless there is nothing to correct; one that waits has none
  CHECK (CASE WHEN status = 'pending_decision' THEN movement_id IS NULL AND variance_qty <> 0
              ELSE (movement_id IS NOT NULL) = (variance_qty <> 0) END)
);
--> statement-breakpoint
CREATE INDEX stock_count_plant_idx ON public.stock_count (plant_id, component_id, created_at);
--> statement-breakpoint
CREATE TABLE public.stock_count_decision (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id     uuid NOT NULL UNIQUE REFERENCES public.stock_count (id),
  accepted     boolean NOT NULL,
  reason       text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 400),
  movement_id  uuid REFERENCES public.stock_movement (id),
  decided_by   uuid NOT NULL,
  decided_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (accepted = (movement_id IS NOT NULL))
);
--> statement-breakpoint

-- Assumption seed (D79, D237): no row is written here (migrations create structure only). The pilot seed inserts the default (200 bp, floor 0, flagged is_assumption) and
-- 0 bp for the admixture; on a real database the owner enters the real tolerance through set_stock_count_tolerance, and a count is refused until one is in force.
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_count_tolerance', 'stock_count', 'stock_count_decision'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    -- insert-only: nothing is updated or deleted, whoever asks
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql SET search_path = '''' AS $f$ BEGIN RAISE EXCEPTION ''%s is insert-only'' USING ERRCODE = ''integrity_constraint_violation''; END $f$',
                   t || '_sealed', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', t || '_sealed', t, t || '_sealed');
  END LOOP;
END $$;
--> statement-breakpoint
-- Read: the owner roles, the plant accounts and support; a plant manager reads only his plant's rows (and the plant-less default tolerance).
CREATE POLICY stock_count_tolerance_read ON public.stock_count_tolerance FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant', 'support')
         AND (ctx.plant_scope() IS NULL OR plant_id IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
CREATE POLICY stock_count_read ON public.stock_count FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant', 'support')
         AND (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
CREATE POLICY stock_count_decision_read ON public.stock_count_decision FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant', 'support')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.stock_count c WHERE c.id = count_id AND c.plant_id = ctx.plant_scope())));
--> statement-breakpoint
SELECT audit.attach('public.stock_count_tolerance');
--> statement-breakpoint
SELECT audit.attach('public.stock_count');
--> statement-breakpoint
SELECT audit.attach('public.stock_count_decision');
--> statement-breakpoint
SELECT public.grant_support_read('public.stock_count_tolerance');
--> statement-breakpoint
SELECT public.grant_support_read('public.stock_count');
--> statement-breakpoint
SELECT public.grant_support_read('public.stock_count_decision');
--> statement-breakpoint

-- The two new notification kinds (a code and a plant, never a figure of money).
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v FROM pg_constraint c WHERE c.conrelid = 'public.notification'::regclass AND c.conname = 'notification_kind_check';
  IF position('''test''::text' IN v) = 0 THEN RAISE EXCEPTION 'notification_kind_check changed shape'; END IF;
  ALTER TABLE public.notification DROP CONSTRAINT notification_kind_check;
  EXECUTE 'ALTER TABLE public.notification ADD CONSTRAINT notification_kind_check ' ||
          replace(v, '''test''::text', '''test''::text, ''stock_count_variance''::text, ''stock_count_decided''::text');
END $$;
--> statement-breakpoint

-- The tolerance in force for (plant, component) on a date: the most specific row wins, then the latest effective date, then the latest insert. Internal (no grant).
CREATE FUNCTION public.count_tolerance_in_force(p_plant uuid, p_component uuid, p_date date)
  RETURNS public.stock_count_tolerance LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.* FROM public.stock_count_tolerance t
   WHERE t.effective_from <= p_date
     AND (t.plant_id IS NULL OR t.plant_id = p_plant)
     AND (t.component_id IS NULL OR t.component_id = p_component)
   ORDER BY (CASE WHEN t.plant_id IS NOT NULL AND t.component_id IS NOT NULL THEN 3
                  WHEN t.component_id IS NOT NULL THEN 2
                  WHEN t.plant_id IS NOT NULL THEN 1 ELSE 0 END) DESC,
            t.effective_from DESC, t.created_at DESC, t.id DESC
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.count_tolerance_in_force(uuid, uuid, date) FROM PUBLIC;
--> statement-breakpoint

-- The owner and app_admin set a tolerance (a new versioned row; nothing is edited).
CREATE FUNCTION public.set_stock_count_tolerance(p_plant uuid, p_component uuid, p_tolerance_bp integer, p_floor bigint, p_effective date, p_reason text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('set_stock_count_tolerance');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'set_stock_count_tolerance: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_plant IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.plant WHERE id = p_plant) THEN
    RAISE EXCEPTION 'set_stock_count_tolerance: unknown plant' USING ERRCODE = 'check_violation';
  END IF;
  IF p_component IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.component WHERE id = p_component) THEN
    RAISE EXCEPTION 'set_stock_count_tolerance: unknown component' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.stock_count_tolerance (id, plant_id, component_id, tolerance_bp, floor_qty, effective_from, is_assumption, created_by, reason)
  VALUES (v_id, p_plant, p_component, p_tolerance_bp, coalesce(p_floor, 0), p_effective, false, ctx.user_id(), btrim(p_reason));
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.set_stock_count_tolerance(uuid, uuid, integer, bigint, date, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_stock_count_tolerance(uuid, uuid, integer, bigint, date, text) TO belgobeton_app;
--> statement-breakpoint

-- The plant manager proposes a count of his own plant. The plant is his scope, never an argument; the variance, the ratio and the tolerance are computed here.
CREATE FUNCTION public.propose_stock_count(p_component uuid, p_counted bigint, p_category text, p_reason text)
  RETURNS TABLE(o_id uuid, o_status text, o_theoretical bigint, o_variance bigint, o_variance_bp bigint, o_tolerance_bp integer, o_movement_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role   text;
  v_plant  uuid;
  v_day    date := (coalesce(ctx.sim_now(), now()) AT TIME ZONE 'Africa/Casablanca')::date;
  v_theo   bigint;
  v_var    bigint;
  v_bp     bigint;
  v_tol    public.stock_count_tolerance%ROWTYPE;
  v_in     boolean;
  v_id     uuid := gen_random_uuid();
  v_mov    uuid;
  v_status text;
BEGIN
  v_role := ctx.require_admitted_actor('propose_stock_count');
  v_plant := ctx.plant_scope();
  IF v_role <> 'plant_manager' OR v_plant IS NULL THEN
    RAISE EXCEPTION 'propose_stock_count: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_counted IS NULL OR p_counted < 0 THEN
    RAISE EXCEPTION 'propose_stock_count: the counted quantity is not valid' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.component c WHERE c.id = p_component AND c.status = 'active') THEN
    RAISE EXCEPTION 'propose_stock_count: unknown component' USING ERRCODE = 'check_violation';
  END IF;
  -- two counts of one component and plant are serialized: the level below is the one the variance is computed from
  PERFORM pg_advisory_xact_lock(hashtextextended('stock:count:' || p_component::text || v_plant::text, 0));
  IF EXISTS (SELECT 1 FROM public.stock_count c WHERE c.plant_id = v_plant AND c.component_id = p_component AND c.status = 'pending_decision'
                AND NOT EXISTS (SELECT 1 FROM public.stock_count_decision d WHERE d.count_id = c.id)) THEN
    RAISE EXCEPTION 'propose_stock_count: a count of this component is waiting for a decision' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(m.qty_base), 0) INTO v_theo FROM public.stock_movement m WHERE m.component_id = p_component AND m.plant_id = v_plant;
  v_var := p_counted - v_theo;
  SELECT * INTO v_tol FROM public.count_tolerance_in_force(v_plant, p_component, v_day);
  IF v_tol.id IS NULL THEN
    RAISE EXCEPTION 'propose_stock_count: no tolerance in force' USING ERRCODE = 'check_violation';
  END IF;
  -- ratio in basis points of the theoretical level, rounded half away from zero; n/a (NULL) when the theoretical level is not positive
  IF v_theo > 0 THEN
    v_bp := sign(v_var) * ((abs(v_var) * 20000 + v_theo) / (2 * v_theo));
  END IF;
  v_in := v_var = 0 OR (v_theo > 0 AND (abs(v_bp) <= v_tol.tolerance_bp OR abs(v_var) <= v_tol.floor_qty));
  v_status := CASE WHEN v_in THEN 'in_tolerance_posted' ELSE 'pending_decision' END;
  IF v_in AND v_var <> 0 THEN
    v_mov := gen_random_uuid();
    INSERT INTO public.stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by)
    VALUES (v_mov, p_component, v_day, v_var, 'count_adjustment', v_id, left(p_category || ': ' || btrim(p_reason), 500), v_plant, ctx.user_id());
  END IF;
  INSERT INTO public.stock_count (id, plant_id, component_id, count_date, counted_qty, theoretical_qty, variance_qty, variance_bp, tolerance_id, tolerance_bp,
                                  floor_qty, in_tolerance, status, category, reason, movement_id, created_by)
  VALUES (v_id, v_plant, p_component, v_day, p_counted, v_theo, v_var, v_bp, v_tol.id, v_tol.tolerance_bp, v_tol.floor_qty, v_in, v_status,
          p_category, btrim(p_reason), v_mov, ctx.user_id());
  IF NOT v_in THEN
    PERFORM public.notify('stock_count_variance', 'important',
                          jsonb_build_object('component', (SELECT c.code FROM public.component c WHERE c.id = p_component)),
                          '/stock', v_plant, ARRAY['owner', 'app_admin', 'plant_manager'], NULL);
  END IF;
  RETURN QUERY SELECT v_id, v_status, v_theo, v_var, v_bp, v_tol.tolerance_bp, v_mov;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.propose_stock_count(uuid, bigint, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.propose_stock_count(uuid, bigint, text, text) TO belgobeton_app;
--> statement-breakpoint

-- The owner or app_admin decides a count that waited: accepting posts the counted variance as a count_adjustment, rejecting asks for a recount. Both with a reason.
CREATE FUNCTION public.decide_stock_count(p_count uuid, p_accept boolean, p_reason text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_c    public.stock_count%ROWTYPE;
  v_mov  uuid;
BEGIN
  v_role := ctx.require_admitted_actor('decide_stock_count');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) OR p_accept IS NULL THEN
    RAISE EXCEPTION 'decide_stock_count: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_c FROM public.stock_count c WHERE c.id = p_count FOR UPDATE;
  IF NOT FOUND OR v_c.status <> 'pending_decision' OR EXISTS (SELECT 1 FROM public.stock_count_decision d WHERE d.count_id = v_c.id) THEN
    RAISE EXCEPTION 'decide_stock_count: no count is waiting for this decision' USING ERRCODE = 'check_violation';
  END IF;
  IF p_accept THEN
    v_mov := gen_random_uuid();
    INSERT INTO public.stock_movement (id, component_id, movement_date, qty_base, source, source_id, reason, plant_id, created_by)
    VALUES (v_mov, v_c.component_id, (coalesce(ctx.sim_now(), now()) AT TIME ZONE 'Africa/Casablanca')::date, v_c.variance_qty, 'count_adjustment', v_c.id,
            left(v_c.category || ': ' || v_c.reason, 500), v_c.plant_id, ctx.user_id());
  END IF;
  INSERT INTO public.stock_count_decision (count_id, accepted, reason, movement_id, decided_by)
  VALUES (v_c.id, p_accept, btrim(p_reason), v_mov, ctx.user_id());
  PERFORM public.notify('stock_count_decided', 'important',
                        jsonb_build_object('component', (SELECT c.code FROM public.component c WHERE c.id = v_c.component_id), 'accepted', p_accept),
                        '/stock', v_c.plant_id, ARRAY['plant_manager'], NULL);
  RETURN v_mov;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.decide_stock_count(uuid, boolean, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.decide_stock_count(uuid, boolean, text) TO belgobeton_app;
