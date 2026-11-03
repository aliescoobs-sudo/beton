-- R7 (CP-PROD-PLAN, REQUIREMENTS-V1 §9, §12; DECISIONS 147): documents. Devis, BL, relevé, facture d'acompte, facture définitive and
-- avoir already exist; this adds what §9 still asks for: the timing of the final invoice as a parameter chosen by the accountant, the
-- invoice numbering that continues from the company's last number of the year, and the gate every number-bearing document a client
-- asks for must pass (an approval card for owner and app_admin, one use, audited). A request holds no amount.
CREATE TABLE public.document_policy (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  invoice_timing text NOT NULL DEFAULT 'per_delivery' CHECK (invoice_timing IN ('full_payment', 'monthly', 'per_delivery')),
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.document_request (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('releve', 'invoice_copy', 'quote_copy', 'avoir_copy', 'bl_copy', 'supplier_statement')),
  party_kind text NOT NULL CHECK (party_kind IN ('client', 'supplier')),
  party_code text NOT NULL CHECK (party_code = btrim(party_code) AND length(party_code) BETWEEN 1 AND 40),
  doc_ref    text CHECK (doc_ref IS NULL OR (doc_ref = btrim(doc_ref) AND length(doc_ref) BETWEEN 1 AND 40)),
  note       text CHECK (note IS NULL OR length(note) <= 300),
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  decided_by uuid,
  decided_at timestamptz,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_by IS NULL)),
  CHECK ((status = 'used') = (used_at IS NOT NULL)),
  CHECK (kind = 'releve' OR kind = 'supplier_statement' OR doc_ref IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX document_request_status_idx ON public.document_request (status, created_at);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_policy', 'document_request'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY support_read ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''support'')', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('SELECT audit.attach(''public.%I'')', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- The policy is not money: every company role reads it. A request is read by the owner (and support); the requester reads their own through a door.
CREATE POLICY document_policy_read ON public.document_policy FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner', 'partner', 'office', 'plant'));
--> statement-breakpoint
CREATE POLICY document_request_read ON public.document_request FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint

-- The accountant chooses when the final invoice is issued; the owner and app_admin can too.
CREATE FUNCTION public.set_invoice_timing(p_timing text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'accountant') THEN
    RAISE EXCEPTION 'invoice_timing: role % may not set it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_timing NOT IN ('full_payment', 'monthly', 'per_delivery') THEN
    RAISE EXCEPTION 'invoice_timing: unknown timing' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.document_policy (id, invoice_timing, updated_by) VALUES (true, p_timing, ctx.user_id())
  ON CONFLICT (id) DO UPDATE SET invoice_timing = EXCLUDED.invoice_timing, updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;
--> statement-breakpoint
CREATE FUNCTION public.invoice_timing() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT invoice_timing FROM public.document_policy), 'per_delivery')
$$;
--> statement-breakpoint

-- The invoice numbering continues from the company's last number of the year: the next invoice is last + 1. It can only move forward.
CREATE FUNCTION public.set_invoice_sequence(p_year integer, p_last integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now integer;
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'invoice_sequence: owner or app_admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_year NOT BETWEEN 2000 AND 2999 OR p_last NOT BETWEEN 1 AND 99999999 THEN
    RAISE EXCEPTION 'invoice_sequence: invalid number' USING ERRCODE = 'check_violation';
  END IF;
  SELECT last_value INTO v_now FROM public.doc_sequence WHERE prefix = 'FA' AND year = p_year;
  IF v_now IS NOT NULL AND p_last <= v_now THEN
    RAISE EXCEPTION 'invoice_sequence: a number already issued cannot be reused' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.doc_sequence (prefix, year, last_value) VALUES ('FA', p_year, p_last)
  ON CONFLICT (prefix, year) DO UPDATE SET last_value = EXCLUDED.last_value;
  RETURN p_last;
END $$;
--> statement-breakpoint

-- The gate: an office asks for a document a client (or supplier) requested; nothing leaves before owner or app_admin approves, once.
CREATE FUNCTION public.request_document(p_kind text, p_party_kind text, p_party_code text, p_doc_ref text, p_note text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_party text := btrim(coalesce(p_party_code, '')); v_ref text := nullif(btrim(coalesce(p_doc_ref, '')), '');
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('office', 'office_sales', 'office_purchases', 'accountant') THEN
    RAISE EXCEPTION 'request_document: role % may not ask for a document', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ctx.actor_role() = 'office_purchases' AND p_party_kind <> 'supplier' THEN
    RAISE EXCEPTION 'request_document: purchases handle suppliers' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ctx.actor_role() = 'office_sales' AND p_party_kind <> 'client' THEN
    RAISE EXCEPTION 'request_document: sales handle clients' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (CASE p_party_kind
            WHEN 'client' THEN EXISTS (SELECT 1 FROM public.client WHERE code = v_party)
            WHEN 'supplier' THEN EXISTS (SELECT 1 FROM public.supplier WHERE code = v_party)
            ELSE false END) THEN
    RAISE EXCEPTION 'request_document: unknown party' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.document_request WHERE requester = ctx.user_id() AND kind = p_kind AND party_code = v_party
                AND doc_ref IS NOT DISTINCT FROM v_ref AND status IN ('pending', 'approved')) THEN
    RAISE EXCEPTION 'request_document: already waiting or approved' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO public.document_request (requester, kind, party_kind, party_code, doc_ref, note)
  VALUES (ctx.user_id(), p_kind, p_party_kind, v_party, v_ref, nullif(btrim(coalesce(p_note, '')), ''))
  RETURNING id INTO v_id;
  PERFORM public.notify('document_request', 'important', jsonb_build_object('kind', p_kind), '/documents/requests', NULL,
                        ARRAY['owner', 'app_admin'], NULL);
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.decide_document_request(p_id uuid, p_approve boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.document_request%ROWTYPE;
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'decide_document_request: role % may not decide', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v FROM public.document_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v.status <> 'pending' THEN RAISE EXCEPTION 'decide_document_request: nothing to decide' USING ERRCODE = 'check_violation'; END IF;
  IF v.requester = ctx.user_id() THEN RAISE EXCEPTION 'decide_document_request: nobody approves their own request' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.document_request SET status = CASE WHEN p_approve THEN 'approved' ELSE 'denied' END, decided_by = ctx.user_id(), decided_at = now()
   WHERE id = p_id;
  RETURN true;
END $$;
--> statement-breakpoint
-- The release: once, to the requester. The use is audited (the table is audited, and the row says who and when).
CREATE FUNCTION public.use_document_request(p_id uuid) RETURNS TABLE(kind text, party_kind text, party_code text, doc_ref text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.document_request%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.document_request d WHERE d.id = p_id FOR UPDATE;
  IF NOT FOUND OR v.requester <> ctx.user_id() OR v.status <> 'approved' THEN
    RAISE EXCEPTION 'use_document_request: not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.document_request d SET status = 'used', used_at = now() WHERE d.id = p_id;
  RETURN QUERY SELECT v.kind, v.party_kind, v.party_code, v.doc_ref;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.my_document_requests() RETURNS TABLE(id uuid, kind text, party_kind text, party_code text, doc_ref text, status text, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.kind, d.party_kind, d.party_code, d.doc_ref, d.status, d.created_at
    FROM public.document_request d WHERE d.requester = ctx.user_id() ORDER BY d.created_at DESC LIMIT 50
$$;
--> statement-breakpoint
CREATE FUNCTION public.document_requests_pending() RETURNS TABLE(id uuid, requester_name text, kind text, party_kind text, party_code text, doc_ref text, note text, created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support') THEN
    RAISE EXCEPTION 'document_requests_pending: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT d.id, u.name, d.kind, d.party_kind, d.party_code, d.doc_ref, d.note, d.created_at
                 FROM public.document_request d JOIN public."user" u ON u.id = d.requester::text
                WHERE d.status = 'pending' ORDER BY d.created_at;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['set_invoice_timing(text)', 'invoice_timing()', 'set_invoice_sequence(integer, integer)',
    'request_document(text, text, text, text, text)', 'decide_document_request(uuid, boolean)', 'use_document_request(uuid)',
    'my_document_requests()', 'document_requests_pending()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
END $$;
