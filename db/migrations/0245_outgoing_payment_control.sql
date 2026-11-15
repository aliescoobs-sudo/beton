-- T19 item 5 (D247): four-eyes control of OUTGOING payments (cheques, LCN, transfers, cash handed to a supplier). No data (decision 79). Forward migration.
-- An outgoing payment of an office role is first PREPARED as a request (outgoing_payment_request: supplier, method, amount, number, bank, due date) by the Assistante,
-- then validated by a DIFFERENT user (middle band), or approved by the owner / app_admin (above the upper limit), and only then ISSUED: the instrument insert of a non-owner role
-- carries the id of a validated or approved request that matches its supplier and amount and has not been used (BEFORE INSERT trigger on payment_instrument; unique request id).
-- Limits are the PARAMETERS payments.small_expense_max_centimes / payments.owner_approval_min_centimes (0244 payment_control_level). Below the small limit a payment is entered
-- as before and is listed in the owner's daily review. owner and app_admin issue at any amount (they ARE the control) and may validate or approve at any amount.
-- Existing instruments and the way they are read are unchanged: the new columns are nullable, the gate applies to new rows only.
CREATE TABLE public.outgoing_payment_request (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES public.supplier (id),
  method          text NOT NULL CHECK (method IN ('cash', 'cheque', 'lcn', 'transfer')),
  amount_centimes bigint NOT NULL CHECK (amount_centimes > 0),
  number          text CHECK (number = btrim(number) AND length(number) BETWEEN 1 AND 60),
  bank            text CHECK (bank = btrim(bank) AND length(bank) BETWEEN 1 AND 80),
  written_date    date,
  note            text CHECK (note = btrim(note) AND length(note) BETWEEN 1 AND 500),
  prepared_by     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.outgoing_payment_request_event (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.outgoing_payment_request (id),
  event      text NOT NULL CHECK (event IN ('prepared', 'validated', 'approved', 'rejected')),
  note       text CHECK (note = btrim(note) AND length(note) BETWEEN 1 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX outgoing_payment_request_event_idx ON public.outgoing_payment_request_event (request_id, seq);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outgoing_payment_request', 'outgoing_payment_request_event'] LOOP
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
ALTER TABLE public.payment_instrument ADD COLUMN control_request_id uuid REFERENCES public.outgoing_payment_request (id);
--> statement-breakpoint
CREATE UNIQUE INDEX payment_instrument_control_request_key ON public.payment_instrument (control_request_id) WHERE control_request_id IS NOT NULL;
--> statement-breakpoint
-- the current state of a request: the last event, and 'issued' once an instrument carries it
CREATE FUNCTION public._outgoing_request_state(p_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.payment_instrument i WHERE i.control_request_id = p_id) THEN 'issued'
              ELSE (SELECT CASE e.event WHEN 'prepared' THEN 'prepared' ELSE e.event END FROM public.outgoing_payment_request_event e WHERE e.request_id = p_id ORDER BY e.seq DESC LIMIT 1) END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._outgoing_request_state(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.outgoing_payment_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text := ctx.actor_role();
  v_r     public.outgoing_payment_request%ROWTYPE;
  v_state text;
  v_level text;
BEGIN
  IF NEW.direction <> 'out' OR NEW.source IS NOT NULL THEN RETURN NEW; END IF;
  -- the opening position (source marked, owner-only by its own guard) and the owner roles are not gated: they ARE the control
  IF v_role IS NOT NULL AND v_role = ANY (ARRAY['owner', 'app_admin', 'system']) THEN RETURN NEW; END IF;
  v_level := public.payment_control_level(NEW.amount_centimes);
  IF v_level = 'small' THEN RETURN NEW; END IF;
  IF NEW.control_request_id IS NULL THEN
    RAISE EXCEPTION 'payment_instrument: an outgoing payment of % centimes needs a validated request (prepare, then validate)', NEW.amount_centimes USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_r FROM public.outgoing_payment_request WHERE id = NEW.control_request_id;
  IF NOT FOUND OR v_r.supplier_id IS DISTINCT FROM NEW.supplier_id OR v_r.amount_centimes <> NEW.amount_centimes OR v_r.method <> NEW.method THEN
    RAISE EXCEPTION 'payment_instrument: the request does not match this payment (supplier, method, amount)' USING ERRCODE = 'check_violation';
  END IF;
  v_state := public._outgoing_request_state(v_r.id);
  IF NOT ((v_level = 'validate' AND v_state = ANY (ARRAY['validated', 'approved'])) OR (v_level = 'owner' AND v_state = 'approved')) THEN
    RAISE EXCEPTION 'payment_instrument: the request is % (needs %)', v_state, CASE v_level WHEN 'owner' THEN 'the owner approval' ELSE 'validation by another user' END USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outgoing_payment_gate BEFORE INSERT ON public.payment_instrument FOR EACH ROW EXECUTE FUNCTION public.outgoing_payment_gate();
--> statement-breakpoint
CREATE FUNCTION public.prepare_outgoing_payment(p_supplier uuid, p_method text, p_amount bigint, p_number text, p_bank text, p_written date, p_note text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('prepare_outgoing_payment');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_purchases']) THEN
    RAISE EXCEPTION 'prepare_outgoing_payment: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.supplier s WHERE s.id = p_supplier) THEN
    RAISE EXCEPTION 'prepare_outgoing_payment: unknown supplier' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.outgoing_payment_request (id, supplier_id, method, amount_centimes, number, bank, written_date, note, prepared_by)
  VALUES (v_id, p_supplier, p_method, p_amount, nullif(btrim(coalesce(p_number, '')), ''), nullif(btrim(coalesce(p_bank, '')), ''), p_written, nullif(btrim(coalesce(p_note, '')), ''), ctx.user_id());
  INSERT INTO public.outgoing_payment_request_event (request_id, event, created_by) VALUES (v_id, 'prepared', ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.decide_outgoing_payment(p_id uuid, p_decision text, p_note text) RETURNS void
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
  INSERT INTO public.outgoing_payment_request_event (request_id, event, note, created_by)
  VALUES (p_id, CASE p_decision WHEN 'validate' THEN 'validated' WHEN 'approve' THEN 'approved' ELSE 'rejected' END, nullif(btrim(coalesce(p_note, '')), ''), ctx.user_id());
END $$;
--> statement-breakpoint
-- office_sales reads ONLY the requests that wait for its validation; the others read the register
CREATE FUNCTION public.outgoing_payment_requests(p_limit integer)
  RETURNS TABLE(o_id uuid, o_supplier_id uuid, o_supplier_code text, o_supplier_name text, o_method text, o_amount bigint, o_number text, o_bank text, o_written date,
                o_note text, o_state text, o_level text, o_prepared_by text, o_created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('outgoing_payment_requests');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_purchases', 'office_sales']) THEN
    RAISE EXCEPTION 'outgoing_payment_requests: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT r.id, r.supplier_id, s.code, s.name, r.method, r.amount_centimes, r.number, r.bank, r.written_date, r.note,
         st.state, public.payment_control_level(r.amount_centimes), (SELECT u.name FROM public."user" u WHERE u.id = r.prepared_by::text), r.created_at
    FROM public.outgoing_payment_request r
    JOIN public.supplier s ON s.id = r.supplier_id
    CROSS JOIN LATERAL (SELECT public._outgoing_request_state(r.id) AS state) st
   WHERE v_role <> 'office_sales' OR (st.state = 'prepared' AND public.payment_control_level(r.amount_centimes) = 'validate')
   ORDER BY r.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 500), 2000));
END $$;
--> statement-breakpoint
-- J-1: the cheques and LCN we issued that fall due on p_date + 1 and are not cleared (the office prepares the funds the day before). owner, app_admin, office_purchases.
CREATE FUNCTION public.outgoing_due_tomorrow(p_date date)
  RETURNS TABLE(o_id uuid, o_supplier_code text, o_supplier_name text, o_method text, o_number text, o_bank text, o_amount bigint, o_due date)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('outgoing_due_tomorrow');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_purchases']) THEN
    RAISE EXCEPTION 'outgoing_due_tomorrow: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT i.id, s.code, s.name, i.method, i.number, i.bank, i.amount_centimes, i.written_date
    FROM public.payment_instrument i JOIN public.supplier s ON s.id = i.supplier_id
   WHERE i.direction = 'out' AND i.written_date = p_date + 1
     AND NOT EXISTS (SELECT 1 FROM public.instrument_event e WHERE e.instrument_id = i.id AND e.event IN ('cleared', 'cancelled', 'bounced'))
   ORDER BY i.amount_centimes DESC;
END $$;
--> statement-breakpoint
-- the owner's daily review: outgoing payments below the small limit entered by an office role on p_date (no validation was needed, so they are looked at)
CREATE FUNCTION public.small_outgoing_review(p_date date)
  RETURNS TABLE(o_id uuid, o_supplier_name text, o_method text, o_amount bigint, o_by text, o_has_number boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('small_outgoing_review');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'small_outgoing_review: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT i.id, s.name, i.method, i.amount_centimes, (SELECT u.name FROM public."user" u WHERE u.id = i.created_by::text), i.number IS NOT NULL
    FROM public.payment_instrument i JOIN public.supplier s ON s.id = i.supplier_id
   WHERE i.direction = 'out' AND i.received_date = p_date AND i.control_request_id IS NULL AND i.source IS NULL
     AND public.payment_control_level(i.amount_centimes) = 'small'
     AND i.created_by::text IN (SELECT u.id FROM public."user" u WHERE u.role IN ('office', 'office_purchases'))
   ORDER BY i.created_at;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.prepare_outgoing_payment(uuid, text, bigint, text, text, date, text)', 'public.decide_outgoing_payment(uuid, text, text)',
    'public.outgoing_payment_requests(integer)', 'public.outgoing_due_tomorrow(date)', 'public.small_outgoing_review(date)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
