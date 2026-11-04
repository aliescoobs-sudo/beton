-- D3 / F03 + F12 (CODEX-REVIEW-FINAL): the decisions that change money or the plant's operations after the fact need a fresh second factor,
-- and the database now refuses them without it. The server action runs `withStepUp`, which hands the service a user marked as stepped up;
-- `inRequest` carries the mark to the database as `app.step_up` for that transaction only; these doors check it. A recovery-code session that
-- has not re-enrolled never gets the mark. Doors covered: the cancellation decision (redirect or loss), the cancellation policy, the
-- cancellation of an unproduced order (a reversing entry), and the forced close of a day. A plain close of a quiet day and the field
-- notices that open a case (cases 3 to 7) stay without step-up: they report, they do not decide.
CREATE FUNCTION public._require_step_up(p_what text) RETURNS void LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF current_setting('app.step_up', true) IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION '%: a fresh second factor is required', p_what USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public._require_step_up(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public._require_step_up(text) TO belgobeton_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.cancel_unproduced_order(p_order uuid, p_reason text, p_today date) RETURNS uuid
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
  PERFORM public._require_step_up('cancel_unproduced_order');
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
CREATE OR REPLACE FUNCTION public.decide_cancellation(p_case uuid, p_decision text, p_redirect_order uuid, p_address_enc text,
                                           p_loss_volume_l integer, p_loss_fuel_l integer, p_loss_minutes integer, p_note text,
                                           p_charge_client boolean, p_now timestamptz)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_c public.cancellation_case%ROWTYPE;
  v_ok boolean;
BEGIN
  PERFORM public._require_step_up('decide_cancellation');
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
CREATE OR REPLACE FUNCTION public.set_cancellation_policy(p_plant_may_decide boolean, p_client_charged boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._require_step_up('set_cancellation_policy');
  IF ctx.actor_role() NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'cancellation_policy: owner or app_admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.cancellation_policy (id, plant_may_decide, client_charged, updated_by)
    VALUES (true, p_plant_may_decide, p_client_charged, ctx.user_id())
    ON CONFLICT (id) DO UPDATE SET plant_may_decide = EXCLUDED.plant_may_decide, client_charged = EXCLUDED.client_charged,
                                   updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.close_day(p_plant uuid, p_date date, p_force boolean, p_note text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_block integer; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_force THEN PERFORM public._require_step_up('close_day (forced)'); END IF;
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'plant_manager') THEN
    RAISE EXCEPTION 'day_close: role % may not close a day', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ctx.actor_role() = 'plant_manager' AND p_plant IS DISTINCT FROM ctx.plant_scope() THEN
    RAISE EXCEPTION 'day_close: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.day_close WHERE plant_id = p_plant AND close_date = p_date) THEN RETURN 'already'; END IF;
  SELECT coalesce(sum(s.n), 0) INTO v_block FROM public.day_close_status(p_plant, p_date) s WHERE s.blocking;
  IF v_block > 0 THEN
    IF NOT (p_force AND ctx.actor_role() IN ('owner', 'app_admin') AND v_note IS NOT NULL) THEN
      PERFORM public.notify('day_close_blocking', 'important', jsonb_build_object('items', v_block), '/day-close', p_plant,
                            ARRAY['owner', 'app_admin'], NULL);
      RETURN 'blocked';
    END IF;
  END IF;
  INSERT INTO public.day_close (plant_id, close_date, forced, note, closed_by) VALUES (p_plant, p_date, v_block > 0, v_note, ctx.user_id());
  RETURN 'closed';
END $$;
