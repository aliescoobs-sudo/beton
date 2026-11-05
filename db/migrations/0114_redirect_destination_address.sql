-- §16.10 of the final review: a redirect decided from a cancellation case carries the destination site's address to the driver.
-- The office form sent only the destination order id and `decide_cancellation` stored `p_address_enc` as it came (null), so the
-- driver was told to redirect with nothing to go to. The driver already reads `redirect_address_enc` (driver_instructions).
CREATE OR REPLACE FUNCTION public.decide_cancellation(p_case uuid, p_decision text, p_redirect_order uuid, p_address_enc text,
                                           p_loss_volume_l integer, p_loss_fuel_l integer, p_loss_minutes integer, p_note text,
                                           p_charge_client boolean, p_now timestamptz)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_c public.cancellation_case%ROWTYPE;
  v_ok boolean;
  v_addr text;
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
    -- §16.10: the redirect carries the destination. An address the deciding person typed wins; otherwise the sealed address of the
    -- destination order's own site is copied (the same ciphertext, re-sealed with the rest by key rotation). A redirect that
    -- would reach the driver with no address at all is refused: "the new address reached the driver" must be true.
    v_addr := coalesce(nullif(btrim(p_address_enc), ''),
                       (SELECT s.address_enc FROM public.sales_order o JOIN public.client_site s ON s.id = o.site_id WHERE o.id = p_redirect_order));
    IF v_addr IS NULL THEN
      RAISE EXCEPTION 'cancellation: the destination has no address to give the driver' USING ERRCODE = 'check_violation';
    END IF;
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
    redirect_address_enc = CASE WHEN p_decision = 'redirect' THEN v_addr END,
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
