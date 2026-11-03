-- R6 (CP-PROD-PLAN, REQUIREMENTS-V1 §8; DECISIONS 146): cancellations and incidents, the seven cases.
-- A case is one row, opened by a reviewed door from the real state of the order (no live rotation = case 1; rotations planned and
-- not loaded = case 2; loaded, on the road, unloading = cases 3 to 5, read from trip_event) or from an incident (6 truck, 7 rejected
-- on site). Nothing is deleted: an order nobody produced is cancelled by the existing reversing entry, a BL keeps its number and is
-- marked "annulé" by the case, a loss is a record (m³, fuel, time). Quantities and times only: no amount in a case or a notice.
-- Who decides redirect or loss is a policy (owner and app_admin; the plant manager of the plant only if the owner allows it).

CREATE TABLE public.cancellation_policy (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  plant_may_decide boolean NOT NULL DEFAULT false,
  client_charged   boolean NOT NULL DEFAULT false,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- No row at install: the defaults (the plant does not decide, the client is not charged) apply until the owner saves a policy.

CREATE TABLE public.cancellation_case (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES public.sales_order(id),
  trip_id            uuid REFERENCES public.trip_plan(id),
  delivery_id        uuid REFERENCES public.delivery(id),
  plant_id           uuid REFERENCES public.plant(id),
  case_no            integer NOT NULL CHECK (case_no BETWEEN 1 AND 7),
  reason             text CHECK (reason IS NULL OR (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500)),
  sample_taken       boolean,
  unloaded_volume_l  integer CHECK (unloaded_volume_l IS NULL OR unloaded_volume_l > 0),
  surplus_volume_l   integer CHECK (surplus_volume_l IS NULL OR surplus_volume_l > 0),
  reversal_order_id  uuid REFERENCES public.sales_order(id),
  avoir_required     boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided')),
  decision           text CHECK (decision IN ('redirect', 'loss', 'return_extra', 'join', 'replacement_truck', 'none')),
  redirect_order_id  uuid REFERENCES public.sales_order(id),
  redirect_address_enc text,
  redirect_ack_at    timestamptz,
  loss_volume_l      integer CHECK (loss_volume_l IS NULL OR loss_volume_l >= 0),
  loss_fuel_l        integer CHECK (loss_fuel_l IS NULL OR loss_fuel_l >= 0),
  loss_minutes       integer CHECK (loss_minutes IS NULL OR loss_minutes >= 0),
  client_charged     boolean NOT NULL DEFAULT false,
  note               text CHECK (note IS NULL OR length(note) <= 300),
  opened_by          uuid NOT NULL,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  decided_by         uuid,
  decided_role       text,
  decided_at         timestamptz,
  CHECK (case_no <> 7 OR reason IS NOT NULL),
  CHECK (case_no <> 5 OR unloaded_volume_l IS NOT NULL),
  CHECK ((status = 'decided') = (decision IS NOT NULL)),
  CHECK (decision <> 'redirect' OR redirect_order_id IS NOT NULL),
  CHECK (decision <> 'loss' OR loss_volume_l IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX cancellation_case_order_idx ON public.cancellation_case (order_id);
--> statement-breakpoint
-- One open case per rotation and per case number: a double tap never opens two.
CREATE UNIQUE INDEX cancellation_case_one_per_trip ON public.cancellation_case (trip_id, case_no) WHERE trip_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX cancellation_case_one_per_order ON public.cancellation_case (order_id, case_no) WHERE trip_id IS NULL;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cancellation_policy', 'cancellation_case'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() IN (''owner'', ''partner'', ''office'', ''plant''))', t || '_read', t);
    EXECUTE format('CREATE POLICY support_read ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''support'')', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('SELECT audit.attach(''public.%I'')', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- A plant manager reads the cases of their own plant only.
DROP POLICY cancellation_case_read ON public.cancellation_case;
--> statement-breakpoint
CREATE POLICY cancellation_case_read ON public.cancellation_case FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office')
         OR (ctx.role() = 'plant' AND (ctx.actor_role() <> 'plant_manager' OR plant_id IS NOT DISTINCT FROM ctx.plant_scope())));
--> statement-breakpoint
CREATE POLICY trip_plan_cancellation_definer_insert ON public.trip_plan_cancellation FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY truck_status_log_definer_insert ON public.truck_status_log FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

-- The strength class in a concrete type code (B25 -> 25). A type without a number only matches itself.
CREATE FUNCTION public.concrete_strength(p_code text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(substring(p_code from '[0-9]+'), '')::integer
$$;
--> statement-breakpoint
CREATE FUNCTION public.cancellation_trip_stage(p_trip uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = p_trip) THEN 'cancelled'
    WHEN EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'unloading_finished') THEN 'finished'
    WHEN EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'unloading_started') THEN 'unloading'
    WHEN EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'departed') THEN 'on_road'
    WHEN EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'loaded') THEN 'loaded'
    ELSE 'planned'
  END
$$;
--> statement-breakpoint

-- Who may open and who may decide.
CREATE FUNCTION public.cancellation_actor_check(p_deciding boolean, p_plant uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role(); v_may boolean;
BEGIN
  IF NOT p_deciding THEN
    IF v_role IS NULL OR v_role NOT IN ('owner', 'app_admin', 'office', 'office_sales', 'partner', 'plant', 'plant_manager') THEN
      RAISE EXCEPTION 'cancellation: role % may not open a case', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN;
  END IF;
  IF v_role IN ('owner', 'app_admin') THEN RETURN; END IF;
  SELECT coalesce((SELECT plant_may_decide FROM public.cancellation_policy), false) INTO v_may;
  IF v_role = 'plant_manager' AND v_may AND p_plant IS NOT NULL AND p_plant = ctx.plant_scope() THEN RETURN; END IF;
  RAISE EXCEPTION 'cancellation: role % may not decide redirect or loss', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint

-- Cases 1 and 2: the order was never produced. Reversing entry (the order and its plan, never deleted), the unstarted rotations are
-- cancelled so the plan reflows, and the plant and the drivers get "cancelled, do not load".
CREATE FUNCTION public.cancel_unproduced_order(p_order uuid, p_reason text, p_today date) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_o public.sales_order%ROWTYPE;
  v_case integer;
  v_id uuid := gen_random_uuid();
  v_rev uuid := gen_random_uuid();
  v_code text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_trips uuid[];
  v_users uuid[];
BEGIN
  PERFORM public.cancellation_actor_check(false, NULL);
  IF ctx.actor_role() IN ('plant', 'plant_manager') THEN
    RAISE EXCEPTION 'cancellation: the plant does not cancel an order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN RAISE EXCEPTION 'cancellation: reason too long' USING ERRCODE = 'check_violation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cancel_order:' || p_order::text, 0));
  SELECT * INTO v_o FROM public.sales_order WHERE id = p_order;
  IF NOT FOUND OR v_o.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'cancellation: unknown order' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = p_order) THEN
    RAISE EXCEPTION 'cancellation: the order is already cancelled' USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery d WHERE d.order_id = p_order AND d.reverses_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)) THEN
    RAISE EXCEPTION 'cancellation: the order already has a live load' USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg(t.id) INTO v_trips FROM public.trip_plan t
   WHERE t.order_id = p_order AND public.cancellation_trip_stage(t.id) <> 'cancelled';
  IF v_trips IS NULL THEN v_case := 1; ELSE
    v_case := 2;
    IF EXISTS (SELECT 1 FROM unnest(v_trips) x WHERE public.cancellation_trip_stage(x) <> 'planned') THEN
      RAISE EXCEPTION 'cancellation: a rotation has started, open the case of that rotation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- the reversing entry (exact negation, reason kept)
  v_code := public.next_doc_number('CMD', extract(year FROM p_today)::integer, 5);
  INSERT INTO public.sales_order (id, code, client_id, site_id, zone_id, concrete_type_id, volume_l, order_date, delivery_date,
                                  selling_price_id, unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes,
                                  total_ttc_centimes, brought_by_user_id, reverses_id, reason, created_by, plant_id)
    SELECT v_rev, v_code, client_id, site_id, zone_id, concrete_type_id, -volume_l, order_date, delivery_date, selling_price_id,
           unit_price_ht_centimes, vat_rate_bp, -total_ht_centimes, -total_vat_centimes, -total_ttc_centimes, brought_by_user_id,
           id, coalesce(v_reason, 'annulation'), ctx.user_id(), plant_id
      FROM public.sales_order WHERE id = p_order;
  INSERT INTO public.payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, reverses_id, created_by)
    SELECT gen_random_uuid(), v_rev, seq, direction, method, due_date, -amount_centimes, id, ctx.user_id()
      FROM public.payment_plan_item WHERE order_id = p_order;
  -- the rotations nobody started leave the plan
  IF v_trips IS NOT NULL THEN
    INSERT INTO public.trip_plan_cancellation (id, trip_id, reason, created_by)
      SELECT gen_random_uuid(), x, coalesce(v_reason, 'annulation'), ctx.user_id() FROM unnest(v_trips) x;
    SELECT array_agg(d.user_id::uuid) INTO v_users FROM public.trip_plan t JOIN public.driver d ON d.id = t.driver_id
     WHERE t.id = ANY (v_trips) AND d.user_id IS NOT NULL;
  END IF;
  INSERT INTO public.cancellation_case (id, order_id, plant_id, case_no, reason, reversal_order_id, status, decision, opened_by,
                                        decided_by, decided_role, decided_at)
    VALUES (v_id, p_order, v_o.plant_id, v_case, v_reason, v_rev, 'decided', 'none', ctx.user_id(), ctx.user_id(), ctx.actor_role(), now());
  -- the reversing rows and the case are captured by the audit triggers of their tables (reason kept on the order row)
  PERFORM public.notify('order_cancelled', 'important', jsonb_build_object('case', v_case, 'order', v_o.code), '/cancellations',
                        v_o.plant_id, ARRAY['owner', 'app_admin'], NULL);
  IF v_case = 2 THEN
    PERFORM public.notify('cancel_do_not_load', 'urgent', jsonb_build_object('order', v_o.code), '/trips', v_o.plant_id,
                          ARRAY['plant_manager', 'plant'], v_users);
  END IF;
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Cases 3 to 7 about one rotation. The case number must agree with the state the tracking shows (3 loaded and not left, 4 on the
-- road, 5 unloading stopped midway), 6 is a truck incident, 7 is a rejection on site (reason mandatory).
CREATE FUNCTION public.open_trip_case(p_trip uuid, p_case integer, p_reason text, p_unloaded_l integer, p_sample boolean, p_now timestamptz)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_t public.trip_plan%ROWTYPE;
  v_o public.sales_order%ROWTYPE;
  v_stage text;
  v_id uuid := gen_random_uuid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_delivery uuid;
  v_surplus integer;
  v_invoiced boolean;
BEGIN
  PERFORM public.cancellation_actor_check(false, NULL);
  IF p_case NOT BETWEEN 3 AND 7 THEN RAISE EXCEPTION 'cancellation: case % is not about a rotation', p_case USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO v_t FROM public.trip_plan WHERE id = p_trip;
  IF NOT FOUND THEN RAISE EXCEPTION 'cancellation: unknown rotation' USING ERRCODE = 'check_violation'; END IF;
  IF ctx.actor_role() = 'plant_manager' AND v_t.plant_id IS DISTINCT FROM ctx.plant_scope() THEN
    RAISE EXCEPTION 'cancellation: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_o FROM public.sales_order WHERE id = v_t.order_id;
  v_stage := public.cancellation_trip_stage(p_trip);
  IF v_stage IN ('cancelled', 'finished') THEN
    RAISE EXCEPTION 'cancellation: the rotation is % ', v_stage USING ERRCODE = 'check_violation';
  END IF;
  IF (p_case = 3 AND v_stage <> 'loaded') OR (p_case = 4 AND v_stage <> 'on_road') OR (p_case = 5 AND v_stage <> 'unloading')
     OR (p_case = 7 AND v_stage NOT IN ('on_road', 'unloading')) OR (p_case = 6 AND v_stage = 'planned' AND false) THEN
    RAISE EXCEPTION 'cancellation: case % does not match the rotation (%)', p_case, v_stage USING ERRCODE = 'check_violation';
  END IF;
  IF p_case = 7 AND v_reason IS NULL THEN RAISE EXCEPTION 'cancellation: a rejection needs a reason' USING ERRCODE = 'check_violation'; END IF;
  IF p_case = 5 AND (p_unloaded_l IS NULL OR p_unloaded_l <= 0 OR p_unloaded_l >= v_t.volume_l) THEN
    RAISE EXCEPTION 'cancellation: the m3 unloaded must be more than 0 and less than the load' USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.delivery_id INTO v_delivery FROM public.trip_event e WHERE e.trip_id = p_trip AND e.step = 'loaded';
  v_surplus := CASE WHEN p_case = 5 THEN v_t.volume_l - p_unloaded_l WHEN p_case = 6 THEN NULL ELSE v_t.volume_l END;
  -- a rejected load already invoiced needs an avoir, which only the owner or app_admin issues
  v_invoiced := p_case = 7 AND EXISTS (SELECT 1 FROM public.invoice_line l WHERE l.delivery_id = v_delivery);
  INSERT INTO public.cancellation_case (id, order_id, trip_id, delivery_id, plant_id, case_no, reason, sample_taken, unloaded_volume_l,
                                        surplus_volume_l, avoir_required, client_charged, opened_by)
    VALUES (v_id, v_t.order_id, p_trip, v_delivery, v_t.plant_id, p_case, v_reason, CASE WHEN p_case = 7 THEN coalesce(p_sample, false) END,
            CASE WHEN p_case = 5 THEN p_unloaded_l END, v_surplus, v_invoiced,
            coalesce((SELECT client_charged FROM public.cancellation_policy), false), ctx.user_id());
  IF p_case = 6 THEN
    -- the truck leaves the planning until repaired (an open breakdown entry, ended by a later entry of the plant)
    INSERT INTO public.truck_status_log (id, truck_id, status, from_date, reason, logged_by)
      VALUES (gen_random_uuid(), v_t.truck_id, 'breakdown', p_now::date, coalesce(v_reason, 'truck incident'), ctx.user_id());
  END IF;
  PERFORM public.notify(CASE WHEN p_case IN (3, 4, 5, 7) THEN 'redirect_proposal' ELSE 'emergency' END,
                        CASE WHEN p_case IN (6, 7) THEN 'urgent' ELSE 'important' END,
                        jsonb_build_object('case', p_case, 'order', v_o.code), '/cancellations', v_t.plant_id,
                        ARRAY['owner', 'app_admin', 'plant_manager'], NULL);
  RETURN v_id;
END $$;
--> statement-breakpoint

-- The same-day open orders that could take the surplus of a case: same type or a lower strength class, not the order itself, not
-- cancelled, and (cases 3 and 4) still inside the workable time counted from mixing. Quantities only.
CREATE FUNCTION public.redirect_candidates(p_case uuid, p_now timestamptz)
  RETURNS TABLE(order_id uuid, order_code text, type_code text, remaining_l integer, site_label text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_c public.cancellation_case%ROWTYPE;
  v_type text;
  v_mixed timestamptz;
  v_limit integer;
BEGIN
  PERFORM public.cancellation_actor_check(false, NULL);
  SELECT * INTO v_c FROM public.cancellation_case WHERE id = p_case;
  IF NOT FOUND OR v_c.case_no NOT IN (3, 4, 5, 7) THEN RETURN; END IF;
  SELECT t.code INTO v_type FROM public.sales_order o JOIN public.concrete_type t ON t.id = o.concrete_type_id WHERE o.id = v_c.order_id;
  SELECT coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'concrete_limit_min'), 120) INTO v_limit;
  SELECT e.at INTO v_mixed FROM public.trip_event e WHERE e.trip_id = v_c.trip_id AND e.step = 'loaded';
  IF v_mixed IS NOT NULL AND p_now > v_mixed + make_interval(mins => v_limit) THEN RETURN; END IF;
  RETURN QUERY
    SELECT o.id, o.code, t.code,
           (o.volume_l - coalesce((SELECT sum(d.volume_l) FROM public.delivery d WHERE d.order_id = o.id), 0))::integer,
           s.label
      FROM public.sales_order o
      JOIN public.concrete_type t ON t.id = o.concrete_type_id
      LEFT JOIN public.client_site s ON s.id = o.site_id
     WHERE o.reverses_id IS NULL AND o.id <> v_c.order_id
       AND o.delivery_date = p_now::date
       AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
       AND (t.code = v_type OR (public.concrete_strength(t.code) IS NOT NULL AND public.concrete_strength(v_type) IS NOT NULL
                                AND public.concrete_strength(t.code) <= public.concrete_strength(v_type)))
       AND o.volume_l - coalesce((SELECT sum(d.volume_l) FROM public.delivery d WHERE d.order_id = o.id), 0) >= coalesce(v_c.surplus_volume_l, 1)
       AND (v_c.plant_id IS NULL OR o.plant_id IS NULL OR o.plant_id = v_c.plant_id)
     ORDER BY o.code;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.decide_cancellation(p_case uuid, p_decision text, p_redirect_order uuid, p_address_enc text,
                                           p_loss_volume_l integer, p_loss_fuel_l integer, p_loss_minutes integer, p_note text,
                                           p_charge_client boolean, p_now timestamptz)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_c public.cancellation_case%ROWTYPE;
  v_ok boolean;
BEGIN
  SELECT * INTO v_c FROM public.cancellation_case WHERE id = p_case FOR UPDATE;
  IF NOT FOUND OR v_c.status <> 'open' THEN RETURN false; END IF;
  PERFORM public.cancellation_actor_check(true, v_c.plant_id);
  IF v_c.avoir_required AND ctx.actor_role() NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'cancellation: an invoiced rejection is decided by the owner or app_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision = 'redirect' THEN
    SELECT EXISTS (SELECT 1 FROM public.redirect_candidates(p_case, p_now) c WHERE c.order_id = p_redirect_order) INTO v_ok;
    IF NOT v_ok THEN RAISE EXCEPTION 'cancellation: that order cannot take the surplus' USING ERRCODE = 'check_violation'; END IF;
  ELSIF p_decision = 'loss' THEN
    IF v_c.case_no = 6 THEN RAISE EXCEPTION 'cancellation: a truck incident has no loss decision' USING ERRCODE = 'check_violation'; END IF;
  ELSIF p_decision IN ('return_extra', 'join', 'replacement_truck') THEN
    IF v_c.case_no <> 6 THEN RAISE EXCEPTION 'cancellation: this decision is for a truck incident' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    RAISE EXCEPTION 'cancellation: unknown decision' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.cancellation_case SET
    status = 'decided', decision = p_decision, decided_by = ctx.user_id(), decided_role = ctx.actor_role(), decided_at = now(),
    redirect_order_id = CASE WHEN p_decision = 'redirect' THEN p_redirect_order END,
    redirect_address_enc = CASE WHEN p_decision = 'redirect' THEN p_address_enc END,
    loss_volume_l = CASE WHEN p_decision = 'loss' THEN coalesce(p_loss_volume_l, surplus_volume_l, 0) END,
    loss_fuel_l = CASE WHEN p_decision = 'loss' THEN coalesce(p_loss_fuel_l, 0) END,
    loss_minutes = CASE WHEN p_decision = 'loss' THEN coalesce(p_loss_minutes, 0) END,
    client_charged = coalesce(p_charge_client, client_charged),
    note = nullif(left(btrim(coalesce(p_note, '')), 300), '')
   WHERE id = p_case;
  IF p_decision = 'loss' THEN
    PERFORM public.notify('loss_recorded', 'important', jsonb_build_object('case', v_c.case_no), '/cancellations', v_c.plant_id,
                          ARRAY['owner', 'app_admin'], NULL);
  ELSIF p_decision = 'redirect' THEN
    PERFORM public.notify('driver_instruction', 'urgent', jsonb_build_object('instruction', 'redirect'), '/driver', NULL, ARRAY[]::text[],
                          (SELECT array_agg(d.user_id::uuid) FROM public.trip_plan t JOIN public.driver d ON d.id = t.driver_id
                            WHERE t.id = v_c.trip_id AND d.user_id IS NOT NULL));
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint

-- The driver acknowledges a redirect of one of their own rotations (case 4 and the others): recorded once.
CREATE FUNCTION public.driver_ack_redirect(p_case uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_ack_redirect: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.cancellation_case c SET redirect_ack_at = now()
   WHERE c.id = p_case AND c.decision = 'redirect' AND c.redirect_ack_at IS NULL
     AND EXISTS (SELECT 1 FROM public.trip_plan t WHERE t.id = c.trip_id AND t.driver_id = v_driver);
  RETURN FOUND;
END $$;
--> statement-breakpoint
-- What a driver sees of a redirect on their own rotations: the address and whether it was acknowledged. No price.
CREATE FUNCTION public.driver_redirects() RETURNS TABLE(case_id uuid, trip_id uuid, address_enc text, acknowledged boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id();
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_redirects: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT c.id, c.trip_id, c.redirect_address_enc, c.redirect_ack_at IS NOT NULL
    FROM public.cancellation_case c JOIN public.trip_plan t ON t.id = c.trip_id
   WHERE t.driver_id = v_driver AND c.decision = 'redirect' AND t.trip_date >= current_date - 1;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.set_cancellation_policy(p_plant_may_decide boolean, p_client_charged boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'cancellation_policy: owner or app_admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.cancellation_policy (id, plant_may_decide, client_charged, updated_by)
    VALUES (true, p_plant_may_decide, p_client_charged, ctx.user_id())
    ON CONFLICT (id) DO UPDATE SET plant_may_decide = EXCLUDED.plant_may_decide, client_charged = EXCLUDED.client_charged,
                                   updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;
--> statement-breakpoint

-- The delivery note keeps its number and says "annulé" when a case annulled the load (redirect or loss), as it does for a reversal.
CREATE OR REPLACE FUNCTION public.delivery_note(p_delivery uuid)
RETURNS TABLE (
  bl_no text, load_date date, loaded_at timestamptz, volume_l integer, cancelled boolean,
  order_code text, client_code text, client_name text, site_label text, zone_name text,
  type_code text, type_label text, truck_code text, truck_plate text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant', 'support') THEN
    RAISE EXCEPTION 'delivery_note: role % may not print a delivery note', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.bl_no, d.load_date, d.loaded_at, d.volume_l,
           (d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
            OR EXISTS (SELECT 1 FROM public.cancellation_case c WHERE c.delivery_id = d.id AND c.decision IN ('redirect', 'loss'))),
           o.code, c.code, c.name, s.label, z.name, t.code, t.label, k.code, k.plate
      FROM public.delivery d
      JOIN public.sales_order o ON o.id = d.order_id
      JOIN public.client c ON c.id = o.client_id
      LEFT JOIN public.client_site s ON s.id = o.site_id
      LEFT JOIN public.zone z ON z.id = o.zone_id
      JOIN public.concrete_type t ON t.id = o.concrete_type_id
      JOIN public.truck k ON k.id = d.truck_id
     WHERE d.id = p_delivery;
END $$;
--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'cancel_unproduced_order(uuid, text, date)', 'open_trip_case(uuid, integer, text, integer, boolean, timestamptz)',
    'redirect_candidates(uuid, timestamptz)',
    'decide_cancellation(uuid, text, uuid, text, integer, integer, integer, text, boolean, timestamptz)',
    'driver_ack_redirect(uuid)', 'driver_redirects()', 'set_cancellation_policy(boolean, boolean)',
    'cancellation_trip_stage(uuid)', 'concrete_strength(text)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
  REVOKE EXECUTE ON FUNCTION public.cancellation_actor_check(boolean, uuid) FROM PUBLIC;
END $$;
