-- T19c A: decide_outgoing_payment requires the step-up mark for an approval above the upper limit (one place for every path). No data.
CREATE OR REPLACE FUNCTION public.decide_outgoing_payment(p_id uuid, p_decision text, p_note text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text;
  v_r     public.outgoing_payment_request%ROWTYPE;
  v_state text;
  v_level text;
BEGIN
  v_role := ctx.require_admitted_actor('decide_outgoing_payment');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_sales']) THEN
    RAISE EXCEPTION 'decide_outgoing_payment: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision IS NULL OR p_decision <> ALL (ARRAY['validate', 'approve', 'reject']) THEN
    RAISE EXCEPTION 'decide_outgoing_payment: validate, approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_r FROM public.outgoing_payment_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'decide_outgoing_payment: unknown request' USING ERRCODE = 'check_violation'; END IF;
  v_state := public._outgoing_request_state(p_id);
  IF v_state <> 'prepared' THEN RAISE EXCEPTION 'decide_outgoing_payment: the request is already %', v_state USING ERRCODE = 'check_violation'; END IF;
  IF v_r.prepared_by = ctx.user_id() THEN RAISE EXCEPTION 'decide_outgoing_payment: nobody decides on their own preparation' USING ERRCODE = 'check_violation'; END IF;
  v_level := public.payment_control_level(v_r.amount_centimes);
  IF v_level = 'small' THEN RAISE EXCEPTION 'decide_outgoing_payment: a small payment needs no validation' USING ERRCODE = 'check_violation'; END IF;
  IF p_decision = 'validate' AND v_level = 'owner' THEN RAISE EXCEPTION 'decide_outgoing_payment: above the upper limit the owner approves' USING ERRCODE = 'check_violation'; END IF;
  IF (p_decision = 'approve' OR (v_level = 'owner' AND p_decision = 'reject')) AND v_role = 'office_sales' THEN
    RAISE EXCEPTION 'decide_outgoing_payment: only the owner or app_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- T19c A (D247): an approval above the upper limit carries the fresh second factor, here, for every path (inbox, request page, direct call).
  -- Checked after the actor and the whole tuple (role, decision, state, level, preparer) so a refusal never leaks which check failed first; no event is written without it.
  IF p_decision = 'approve' AND v_level = 'owner' THEN PERFORM public._require_step_up('decide_outgoing_payment (approval above the upper limit)'); END IF;
  INSERT INTO public.outgoing_payment_request_event (request_id, event, note, created_by)
  VALUES (p_id, CASE p_decision WHEN 'validate' THEN 'validated' WHEN 'approve' THEN 'approved' ELSE 'rejected' END, nullif(btrim(coalesce(p_note, '')), ''), ctx.user_id());
END $$;
