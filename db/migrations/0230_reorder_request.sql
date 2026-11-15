-- T15 G2 (SPEC-stock-engine-gaps §6; D233): the reorder request, plant manager -> office_purchases, and the link to the existing purchase flow.
--   reorder_request        one row per request, insert-only: plant, component, quantity in base units, needed by, reason, auto flag (created by the daily job), the level and the
--                          threshold the job saw. At most ONE open request per (plant, component) (a trigger, under an advisory lock, so no writer can stack two).
--   reorder_request_event  insert-only status history: open (written with the request) -> seen -> ordered | cancelled; `ordered` carries the purchase it was converted into.
--                          The state of a request is its latest event. Nothing is edited, nothing is deleted.
-- Doors (SECURITY DEFINER, actor-first): create_reorder_request (plant manager, own plant), mark_reorder_seen / link_reorder_to_purchase (office_purchases, owner, app_admin),
-- cancel_reorder_request (the plant manager of the plant, owner, app_admin), create_auto_reorder_requests (the system actor only, run by the daily job reorder-auto).
-- Quantities only: no price, no balance. No AI creates or sends a request (CLAUDE.md): the auto job is deterministic code over thresholds.
-- Forward migration.
CREATE TABLE public.reorder_request (
  id              uuid PRIMARY KEY,
  plant_id        uuid   NOT NULL REFERENCES public.plant (id),
  component_id    uuid   NOT NULL REFERENCES public.component (id),
  requested_qty   bigint NOT NULL CHECK (requested_qty > 0),
  needed_by       date   NOT NULL,
  reason          text   NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 400),
  auto_from_threshold boolean NOT NULL DEFAULT false,
  -- what the daily job saw (NULL for a request by hand)
  level_qty       bigint,
  threshold_qty   bigint,
  created_by      uuid   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (auto_from_threshold = (level_qty IS NOT NULL AND threshold_qty IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX reorder_request_plant_idx ON public.reorder_request (plant_id, component_id, created_at);
--> statement-breakpoint
CREATE TABLE public.reorder_request_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid    NOT NULL REFERENCES public.reorder_request (id),
  seq          integer NOT NULL CHECK (seq >= 1),
  status       text    NOT NULL CHECK (status IN ('open', 'seen', 'ordered', 'cancelled')),
  purchase_id  uuid REFERENCES public.purchase (id),
  reason       text CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 400),
  created_by   uuid    NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, seq),
  UNIQUE (request_id, status),
  CHECK ((status = 'ordered') = (purchase_id IS NOT NULL)),
  CHECK (status <> 'cancelled' OR reason IS NOT NULL),
  CHECK ((status = 'open') = (seq = 1))
);
--> statement-breakpoint

-- The daily door reads the thresholds as the definer (as it reads components, plants and movements).
CREATE POLICY stock_threshold_definer_read ON public.stock_threshold FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- State of a request = its latest event. Internal helper (no grant): the doors read it under the request's lock.
CREATE FUNCTION public.reorder_state(p_request uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.status FROM public.reorder_request_event e WHERE e.request_id = p_request ORDER BY e.seq DESC LIMIT 1
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.reorder_state(uuid) FROM PUBLIC;
--> statement-breakpoint

-- One open request per (plant, component), whoever writes: checked under an advisory lock so two concurrent writers cannot both pass.
CREATE FUNCTION public.reorder_request_one_open() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('reorder:' || NEW.plant_id::text || NEW.component_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.reorder_request r
              WHERE r.plant_id = NEW.plant_id AND r.component_id = NEW.component_id AND r.id <> NEW.id
                AND public.reorder_state(r.id) IN ('open', 'seen')) THEN
    RAISE EXCEPTION 'reorder_request: a request for this component is already open at this plant' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER reorder_request_one_open BEFORE INSERT ON public.reorder_request
  FOR EACH ROW EXECUTE FUNCTION public.reorder_request_one_open();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reorder_request', 'reorder_request_event'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql SET search_path = '''' AS $f$ BEGIN RAISE EXCEPTION ''%s is insert-only'' USING ERRCODE = ''integrity_constraint_violation''; END $f$',
                   t || '_sealed', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', t || '_sealed', t, t || '_sealed');
  END LOOP;
END $$;
--> statement-breakpoint
-- Read: the owner roles, the plant accounts (a plant manager only his plant), support, and office_purchases (every plant: quantities and components, no balance).
CREATE POLICY reorder_request_read ON public.reorder_request FOR SELECT TO belgobeton_app
  USING ((ctx.role() IN ('owner', 'partner', 'plant', 'support') OR ctx.actor_role() = 'office_purchases')
         AND (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
CREATE POLICY reorder_request_event_read ON public.reorder_request_event FOR SELECT TO belgobeton_app
  USING ((ctx.role() IN ('owner', 'partner', 'plant', 'support') OR ctx.actor_role() = 'office_purchases')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.reorder_request r WHERE r.id = request_id AND r.plant_id = ctx.plant_scope())));
--> statement-breakpoint
SELECT audit.attach('public.reorder_request');
--> statement-breakpoint
SELECT audit.attach('public.reorder_request_event');
--> statement-breakpoint
SELECT public.grant_support_read('public.reorder_request');
--> statement-breakpoint
SELECT public.grant_support_read('public.reorder_request_event');
--> statement-breakpoint

DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v FROM pg_constraint c WHERE c.conrelid = 'public.notification'::regclass AND c.conname = 'notification_kind_check';
  IF position('''test''::text' IN v) = 0 THEN RAISE EXCEPTION 'notification_kind_check changed shape'; END IF;
  ALTER TABLE public.notification DROP CONSTRAINT notification_kind_check;
  EXECUTE 'ALTER TABLE public.notification ADD CONSTRAINT notification_kind_check ' ||
          replace(v, '''test''::text', '''test''::text, ''reorder_request''::text');
END $$;
--> statement-breakpoint

-- The same formula as src/modules/operations/domain/stock.ts reorderThreshold (a test keeps the two equal): ceil(consumed x (lead + safety days) / window), NULL without consumption.
CREATE FUNCTION public.reorder_threshold_qty(p_consumed bigint, p_window integer, p_lead integer, p_safety integer)
  RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_window <= 0 OR p_consumed <= 0 THEN NULL
              ELSE (p_consumed * (greatest(0, p_lead) + greatest(0, p_safety)) + p_window - 1) / p_window END
$$;
--> statement-breakpoint

-- The plant manager asks for a component of his own plant.
CREATE FUNCTION public.create_reorder_request(p_component uuid, p_qty bigint, p_needed_by date, p_reason text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text;
  v_plant uuid;
  v_id    uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('create_reorder_request');
  v_plant := ctx.plant_scope();
  IF v_role <> 'plant_manager' OR v_plant IS NULL THEN
    RAISE EXCEPTION 'create_reorder_request: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 OR p_needed_by IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.component c WHERE c.id = p_component AND c.status = 'active') THEN
    RAISE EXCEPTION 'create_reorder_request: not valid' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.reorder_request (id, plant_id, component_id, requested_qty, needed_by, reason, auto_from_threshold, created_by)
  VALUES (v_id, v_plant, p_component, p_qty, p_needed_by, btrim(p_reason), false, ctx.user_id());
  INSERT INTO public.reorder_request_event (request_id, seq, status, created_by) VALUES (v_id, 1, 'open', ctx.user_id());
  PERFORM public.notify('reorder_request', 'important',
                        jsonb_build_object('component', (SELECT c.code FROM public.component c WHERE c.id = p_component)),
                        '/stock', v_plant, ARRAY['office_purchases', 'owner', 'app_admin'], NULL);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- office_purchases (and the owner roles) mark a request seen.
CREATE FUNCTION public.mark_reorder_seen(p_request uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('mark_reorder_seen');
  IF v_role <> ALL (ARRAY['office_purchases', 'owner', 'app_admin']) THEN
    RAISE EXCEPTION 'mark_reorder_seen: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM public.reorder_request r WHERE r.id = p_request FOR UPDATE;
  IF NOT FOUND OR public.reorder_state(p_request) IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'mark_reorder_seen: no open request' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.reorder_request_event (request_id, seq, status, created_by)
  VALUES (p_request, (SELECT max(e.seq) + 1 FROM public.reorder_request_event e WHERE e.request_id = p_request), 'seen', ctx.user_id());
END $$;
--> statement-breakpoint

-- The conversion: the request is linked to an existing purchase (ACH-...) that orders its component for its plant. The whole tuple is checked.
CREATE FUNCTION public.link_reorder_to_purchase(p_request uuid, p_purchase_code text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_r    public.reorder_request%ROWTYPE;
  v_p    uuid;
BEGIN
  v_role := ctx.require_admitted_actor('link_reorder_to_purchase');
  IF v_role <> ALL (ARRAY['office_purchases', 'owner', 'app_admin']) THEN
    RAISE EXCEPTION 'link_reorder_to_purchase: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_r FROM public.reorder_request r WHERE r.id = p_request FOR UPDATE;
  IF NOT FOUND OR public.reorder_state(p_request) NOT IN ('open', 'seen') THEN
    RAISE EXCEPTION 'link_reorder_to_purchase: no open request' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.id INTO v_p FROM public.purchase p
                  WHERE p.code = p_purchase_code AND p.reverses_id IS NULL AND (p.plant_id IS NULL OR p.plant_id = v_r.plant_id)
                    AND NOT EXISTS (SELECT 1 FROM public.purchase x WHERE x.reverses_id = p.id)
                    AND EXISTS (SELECT 1 FROM public.purchase_line l WHERE l.purchase_id = p.id AND l.component_id = v_r.component_id);
  IF v_p IS NULL THEN
    RAISE EXCEPTION 'link_reorder_to_purchase: this purchase does not order the component for this plant' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.reorder_request_event (request_id, seq, status, purchase_id, created_by)
  VALUES (p_request, (SELECT max(e.seq) + 1 FROM public.reorder_request_event e WHERE e.request_id = p_request), 'ordered', v_p, ctx.user_id());
END $$;
--> statement-breakpoint

-- Cancelling: the plant manager of the plant, the owner and app_admin; with a reason. An ordered request is not cancelled (the purchase is corrected in its own flow).
CREATE FUNCTION public.cancel_reorder_request(p_request uuid, p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_r    public.reorder_request%ROWTYPE;
BEGIN
  v_role := ctx.require_admitted_actor('cancel_reorder_request');
  IF v_role <> ALL (ARRAY['plant_manager', 'owner', 'app_admin']) THEN
    RAISE EXCEPTION 'cancel_reorder_request: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_r FROM public.reorder_request r WHERE r.id = p_request FOR UPDATE;
  -- a plant manager reaches only his own plant's requests: another plant's, an unknown one and a closed one are ONE answer
  IF NOT FOUND OR (v_role = 'plant_manager' AND v_r.plant_id IS DISTINCT FROM ctx.plant_scope())
     OR public.reorder_state(p_request) NOT IN ('open', 'seen') THEN
    RAISE EXCEPTION 'cancel_reorder_request: no open request' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.reorder_request_event (request_id, seq, status, reason, created_by)
  VALUES (p_request, (SELECT max(e.seq) + 1 FROM public.reorder_request_event e WHERE e.request_id = p_request), 'cancelled', btrim(p_reason), ctx.user_id());
END $$;
--> statement-breakpoint

-- The list the screens read: state, component, plant and, once ordered, the purchase code (office_purchases cannot read purchases themselves). Quantities only.
CREATE FUNCTION public.reorder_requests_list()
  RETURNS TABLE(o_id uuid, o_plant_id uuid, o_plant_code text, o_component_id uuid, o_name_fr text, o_name_ar text, o_base_unit text, o_qty bigint,
                o_needed_by date, o_reason text, o_auto boolean, o_state text, o_purchase_code text, o_created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('reorder_requests_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'plant', 'plant_manager', 'office_purchases']) THEN
    RAISE EXCEPTION 'reorder_requests_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT r.id, r.plant_id, p.code, r.component_id, c.name_fr, c.name_ar, c.base_unit, r.requested_qty, r.needed_by, r.reason, r.auto_from_threshold,
           public.reorder_state(r.id),
           (SELECT pu.code FROM public.reorder_request_event e JOIN public.purchase pu ON pu.id = e.purchase_id WHERE e.request_id = r.id AND e.status = 'ordered'),
           r.created_at
      FROM public.reorder_request r JOIN public.plant p ON p.id = r.plant_id JOIN public.component c ON c.id = r.component_id
     WHERE (ctx.plant_scope() IS NULL OR r.plant_id = ctx.plant_scope())
     ORDER BY r.created_at DESC, r.id DESC LIMIT 200;
END $$;
--> statement-breakpoint

-- The daily job (system actor only): for every active plant and active component whose level is below the threshold (set by hand, else derived from the last 30 days of loads)
-- and with no open request, one request for the difference, needed by today + the component's lead time. Created by the system actor; returns how many were created.
CREATE FUNCTION public.create_auto_reorder_requests(p_today date) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n   integer := 0;
  r     record;
  v_id  uuid;
BEGIN
  IF ctx.actor_role() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'create_auto_reorder_requests: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_today IS NULL THEN
    RAISE EXCEPTION 'create_auto_reorder_requests: a date is required' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN
    SELECT p.id AS plant_id, c.id AS component_id, c.code, coalesce(c.lead_time_days, 2) AS lead,
           lv.level, th.threshold
      FROM public.plant p
      CROSS JOIN public.component c
      CROSS JOIN LATERAL (SELECT coalesce(sum(m.qty_base), 0) AS level FROM public.stock_movement m
                           WHERE m.plant_id = p.id AND m.component_id = c.id) lv
      CROSS JOIN LATERAL (
        SELECT coalesce(
                 (SELECT t.low_qty_base FROM public.stock_threshold t WHERE t.component_id = c.id AND t.plant_id = p.id ORDER BY t.created_at DESC, t.id DESC LIMIT 1),
                 public.reorder_threshold_qty(
                   (SELECT (-sum(m.qty_base))::bigint FROM public.stock_movement m
                     WHERE m.component_id = c.id AND m.plant_id = p.id AND m.source IN ('delivery', 'reversal')
                       AND m.movement_date > p_today - 30 AND m.movement_date <= p_today),
                   30, coalesce(c.lead_time_days, 2), 1)) AS threshold) th
     WHERE p.status = 'active' AND c.status = 'active' AND th.threshold IS NOT NULL AND lv.level < th.threshold
     ORDER BY p.id, c.code
  LOOP
    -- a request already open for this pair: skipped (the job may run twice); the trigger enforces the same rule for any other writer
    IF EXISTS (SELECT 1 FROM public.reorder_request q WHERE q.plant_id = r.plant_id AND q.component_id = r.component_id
                  AND public.reorder_state(q.id) IN ('open', 'seen')) THEN
      CONTINUE;
    END IF;
    v_id := gen_random_uuid();
    INSERT INTO public.reorder_request (id, plant_id, component_id, requested_qty, needed_by, reason, auto_from_threshold, level_qty, threshold_qty, created_by)
    VALUES (v_id, r.plant_id, r.component_id, r.threshold - r.level, p_today + r.lead, 'automatic: level below the threshold', true, r.level, r.threshold, ctx.user_id());
    INSERT INTO public.reorder_request_event (request_id, seq, status, created_by) VALUES (v_id, 1, 'open', ctx.user_id());
    PERFORM public.notify('reorder_request', 'important', jsonb_build_object('component', r.code), '/stock', r.plant_id,
                          ARRAY['office_purchases', 'owner', 'app_admin', 'plant_manager'], NULL);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.create_reorder_request(uuid, bigint, date, text)', 'public.mark_reorder_seen(uuid)',
                           'public.link_reorder_to_purchase(uuid, text)', 'public.reorder_requests_list()', 'public.cancel_reorder_request(uuid, text)',
                           'public.create_auto_reorder_requests(date)', 'public.reorder_threshold_qty(bigint, integer, integer, integer)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  GRANT EXECUTE ON FUNCTION public.create_reorder_request(uuid, bigint, date, text) TO belgobeton_app;
  GRANT EXECUTE ON FUNCTION public.mark_reorder_seen(uuid) TO belgobeton_app;
  GRANT EXECUTE ON FUNCTION public.link_reorder_to_purchase(uuid, text) TO belgobeton_app;
  GRANT EXECUTE ON FUNCTION public.reorder_requests_list() TO belgobeton_app;
  GRANT EXECUTE ON FUNCTION public.cancel_reorder_request(uuid, text) TO belgobeton_app;
  -- the job runs as the system login only; the pure formula is callable by the tests' logins that run the job
  GRANT EXECUTE ON FUNCTION public.create_auto_reorder_requests(date) TO belgobeton_system;
  GRANT EXECUTE ON FUNCTION public.reorder_threshold_qty(bigint, integer, integer, integer) TO belgobeton_system, belgobeton_app;
END $$;
