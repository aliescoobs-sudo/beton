-- T19 item 6 (D245, D247): the charges register of the Assistante, on top of the money records. No data (decision 79). Forward migration.
-- charge / charge_event: insert-only, doors-only (no request role touches them), audit-captured. A charge is a beneficiary, a category, HT / VAT / TTC, the payment mode,
-- whether the supporting document was received (and its reference) and a status that is the LAST EVENT (recorded, validated, approved, rejected, paid, reversed), so nothing is edited.
-- The control follows D247 and its two PARAMETERS (payments.small_expense_max_centimes, payments.owner_approval_min_centimes):
--   TTC below the small limit      recorded and payable at once; listed in the owner's daily review;
--   from the small limit to the upper limit   a DIFFERENT user (office_sales, owner or app_admin) validates before it can be paid;
--   above the upper limit          owner or app_admin approves in the application before it can be paid.
-- A charge paid without a supporting document is FLAGGED (no_document), never silently accepted; the document can be added later (document_added event).
-- Doors (actor first): record_charge, decide_charge, mark_charge_paid, add_charge_document, reverse_charge, charge_list. The finance schema is not touched.
CREATE FUNCTION public.payment_control_level(p_ttc bigint) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_small bigint := coalesce((SELECT (p.value #>> '{}')::bigint FROM public.parameter p WHERE p.key = 'payments.small_expense_max_centimes'), 100000);
  v_upper bigint := coalesce((SELECT (p.value #>> '{}')::bigint FROM public.parameter p WHERE p.key = 'payments.owner_approval_min_centimes'), 500000);
BEGIN
  IF p_ttc > v_upper THEN RETURN 'owner'; END IF;
  IF p_ttc >= v_small THEN RETURN 'validate'; END IF;
  RETURN 'small';
END $$;
--> statement-breakpoint
CREATE TABLE public.charge (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_date       date NOT NULL,
  beneficiary       text NOT NULL CHECK (beneficiary = btrim(beneficiary) AND length(beneficiary) BETWEEN 2 AND 120),
  category          text NOT NULL CHECK (category IN ('rent', 'electricity_water', 'telecom', 'insurance', 'maintenance', 'transport', 'taxes_fees', 'bank_fees', 'supplies', 'other')),
  amount_ht_centimes  bigint NOT NULL CHECK (amount_ht_centimes >= 0),
  amount_vat_centimes bigint NOT NULL CHECK (amount_vat_centimes >= 0),
  amount_ttc_centimes bigint NOT NULL CHECK (amount_ttc_centimes > 0),
  payment_mode      text NOT NULL CHECK (payment_mode IN ('cash', 'cheque', 'transfer', 'card')),
  document_ref      text CHECK (document_ref = btrim(document_ref) AND length(document_ref) BETWEEN 1 AND 80),
  note              text CHECK (note = btrim(note) AND length(note) BETWEEN 1 AND 500),
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_ttc_centimes = amount_ht_centimes + amount_vat_centimes)
);
--> statement-breakpoint
CREATE TABLE public.charge_event (
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  charge_id    uuid NOT NULL REFERENCES public.charge (id),
  event        text NOT NULL CHECK (event IN ('recorded', 'validated', 'approved', 'rejected', 'paid', 'document_added', 'reversed')),
  document_ref text CHECK (document_ref = btrim(document_ref) AND length(document_ref) BETWEEN 1 AND 80),
  note         text CHECK (note = btrim(note) AND length(note) BETWEEN 1 AND 500),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX charge_event_charge_idx ON public.charge_event (charge_id, seq);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['charge', 'charge_event'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql SET search_path = '''' AS $f$ BEGIN RAISE EXCEPTION ''%s is insert-only'' USING ERRCODE = ''integrity_constraint_violation''; END $f$', t || '_sealed', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', t || '_sealed', t, t || '_sealed');
    EXECUTE format('SELECT audit.attach(%L)', 'public.' || t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.record_charge(p_date date, p_beneficiary text, p_category text, p_ht bigint, p_vat bigint, p_mode text, p_document_ref text, p_note text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('record_charge');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_purchases']) THEN
    RAISE EXCEPTION 'record_charge: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.charge (id, charge_date, beneficiary, category, amount_ht_centimes, amount_vat_centimes, amount_ttc_centimes, payment_mode, document_ref, note, created_by)
  VALUES (v_id, p_date, btrim(p_beneficiary), p_category, p_ht, p_vat, p_ht + p_vat, p_mode, nullif(btrim(coalesce(p_document_ref, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), ctx.user_id());
  INSERT INTO public.charge_event (charge_id, event, document_ref, created_by) VALUES (v_id, 'recorded', nullif(btrim(coalesce(p_document_ref, '')), ''), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
-- validate (a different user, middle band), approve (owner or app_admin, any band; required above the upper limit) or reject (owner or app_admin, or the validator of the middle band)
CREATE FUNCTION public.decide_charge(p_id uuid, p_decision text, p_note text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text;
  v_c     public.charge%ROWTYPE;
  v_last  text;
  v_level text;
BEGIN
  v_role := ctx.require_admitted_actor('decide_charge');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_sales']) THEN
    RAISE EXCEPTION 'decide_charge: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision IS NULL OR p_decision <> ALL (ARRAY['validate', 'approve', 'reject']) THEN
    RAISE EXCEPTION 'decide_charge: validate, approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_c FROM public.charge WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'decide_charge: unknown charge' USING ERRCODE = 'check_violation'; END IF;
  SELECT e.event INTO v_last FROM public.charge_event e WHERE e.charge_id = p_id AND e.event <> 'document_added' ORDER BY e.seq DESC LIMIT 1;
  IF v_last <> 'recorded' THEN
    RAISE EXCEPTION 'decide_charge: the charge is already %', v_last USING ERRCODE = 'check_violation';
  END IF;
  v_level := public.payment_control_level(v_c.amount_ttc_centimes);
  -- nobody validates, approves or rejects what they prepared themselves
  IF v_c.created_by = ctx.user_id() THEN
    RAISE EXCEPTION 'decide_charge: nobody decides on their own preparation' USING ERRCODE = 'check_violation';
  END IF;
  IF v_level = 'small' THEN
    RAISE EXCEPTION 'decide_charge: a small expense needs no validation' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'validate' AND v_level = 'owner' THEN
    RAISE EXCEPTION 'decide_charge: above the upper limit the owner approves' USING ERRCODE = 'check_violation';
  END IF;
  IF (p_decision = 'approve' OR (v_level = 'owner' AND p_decision = 'reject')) AND v_role = 'office_sales' THEN
    RAISE EXCEPTION 'decide_charge: only the owner or app_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.charge_event (charge_id, event, note, created_by)
  VALUES (p_id, CASE p_decision WHEN 'validate' THEN 'validated' WHEN 'approve' THEN 'approved' ELSE 'rejected' END, nullif(btrim(coalesce(p_note, '')), ''), ctx.user_id());
END $$;
--> statement-breakpoint
CREATE FUNCTION public.mark_charge_paid(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text;
  v_c     public.charge%ROWTYPE;
  v_last  text;
  v_level text;
  v_doc   boolean;
BEGIN
  v_role := ctx.require_admitted_actor('mark_charge_paid');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_purchases']) THEN
    RAISE EXCEPTION 'mark_charge_paid: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_c FROM public.charge WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'mark_charge_paid: unknown charge' USING ERRCODE = 'check_violation'; END IF;
  SELECT e.event INTO v_last FROM public.charge_event e WHERE e.charge_id = p_id AND e.event <> 'document_added' ORDER BY e.seq DESC LIMIT 1;
  v_level := public.payment_control_level(v_c.amount_ttc_centimes);
  IF v_last = 'paid' OR v_last = 'rejected' OR v_last = 'reversed' THEN
    RAISE EXCEPTION 'mark_charge_paid: the charge is already %', v_last USING ERRCODE = 'check_violation';
  END IF;
  IF (v_level = 'validate' AND v_last <> ALL (ARRAY['validated', 'approved'])) OR (v_level = 'owner' AND v_last <> 'approved') THEN
    RAISE EXCEPTION 'mark_charge_paid: the charge needs its %', CASE v_level WHEN 'owner' THEN 'owner approval' ELSE 'validation by another user' END USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.charge_event (charge_id, event, created_by) VALUES (p_id, 'paid', ctx.user_id());
  -- the flag: no supporting document yet (the document can still be added)
  SELECT EXISTS (SELECT 1 FROM public.charge_event e WHERE e.charge_id = p_id AND e.document_ref IS NOT NULL) INTO v_doc;
  RETURN v_doc;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.add_charge_document(p_id uuid, p_ref text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('add_charge_document');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_purchases']) THEN
    RAISE EXCEPTION 'add_charge_document: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.charge WHERE id = p_id) THEN RAISE EXCEPTION 'add_charge_document: unknown charge' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO public.charge_event (charge_id, event, document_ref, created_by) VALUES (p_id, 'document_added', btrim(p_ref), ctx.user_id());
END $$;
--> statement-breakpoint
CREATE FUNCTION public.reverse_charge(p_id uuid, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_last text;
BEGIN
  v_role := ctx.require_admitted_actor('reverse_charge');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'reverse_charge: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN RAISE EXCEPTION 'reverse_charge: a reason is required' USING ERRCODE = 'check_violation'; END IF;
  SELECT e.event INTO v_last FROM public.charge_event e WHERE e.charge_id = p_id AND e.event <> 'document_added' ORDER BY e.seq DESC LIMIT 1;
  IF v_last IS NULL OR v_last = 'reversed' THEN RAISE EXCEPTION 'reverse_charge: nothing to reverse' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO public.charge_event (charge_id, event, note, created_by) VALUES (p_id, 'reversed', btrim(p_reason), ctx.user_id());
END $$;
--> statement-breakpoint
-- The list. office_purchases, owner and app_admin read everything; office_sales reads ONLY what waits for its validation (middle band, recorded): it decides, it does not browse.
CREATE FUNCTION public.charge_list(p_from date, p_to date, p_limit integer)
  RETURNS TABLE(o_id uuid, o_date date, o_beneficiary text, o_category text, o_ht bigint, o_vat bigint, o_ttc bigint, o_mode text, o_status text, o_level text,
                o_document_ref text, o_no_document boolean, o_prepared_by text, o_decided_by text, o_note text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('charge_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_purchases', 'office_sales']) THEN
    RAISE EXCEPTION 'charge_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  WITH x AS (
    SELECT c.*, public.payment_control_level(c.amount_ttc_centimes) AS lvl,
           (SELECT e.event FROM public.charge_event e WHERE e.charge_id = c.id AND e.event <> 'document_added' ORDER BY e.seq DESC LIMIT 1) AS last_event,
           (SELECT e.document_ref FROM public.charge_event e WHERE e.charge_id = c.id AND e.document_ref IS NOT NULL ORDER BY e.seq DESC LIMIT 1) AS doc,
           (SELECT u.name FROM public."user" u WHERE u.id = c.created_by::text) AS prep,
           (SELECT u.name FROM public.charge_event e JOIN public."user" u ON u.id = e.created_by::text
             WHERE e.charge_id = c.id AND e.event IN ('validated', 'approved', 'rejected') ORDER BY e.seq DESC LIMIT 1) AS decider
      FROM public.charge c
     WHERE (p_from IS NULL OR c.charge_date >= p_from) AND (p_to IS NULL OR c.charge_date <= p_to)
  )
  SELECT x.id, x.charge_date, x.beneficiary, x.category, x.amount_ht_centimes, x.amount_vat_centimes, x.amount_ttc_centimes, x.payment_mode,
         CASE WHEN x.last_event = 'recorded' AND x.lvl = 'validate' THEN 'pending_validation'
              WHEN x.last_event = 'recorded' AND x.lvl = 'owner' THEN 'pending_approval'
              WHEN x.last_event = 'recorded' THEN 'recorded'
              ELSE x.last_event END,
         x.lvl, x.doc, (x.doc IS NULL AND x.last_event <> ALL (ARRAY['rejected', 'reversed'])),
         x.prep, x.decider, x.note
    FROM x
   WHERE v_role <> 'office_sales' OR (x.last_event = 'recorded' AND x.lvl = 'validate')
   ORDER BY x.charge_date DESC, x.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 500), 2000));
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.record_charge(date, text, text, bigint, bigint, text, text, text)', 'public.decide_charge(uuid, text, text)', 'public.mark_charge_paid(uuid)',
    'public.add_charge_document(uuid, text)', 'public.reverse_charge(uuid, text)', 'public.charge_list(date, date, integer)', 'public.payment_control_level(bigint)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
