-- F08 of the final review: the approval of a document request is tied to the actual download.
-- A client copy (invoice, avoir, quote, BL) is delivered only against an approved request that is: (1) the requester's own,
-- (2) for this kind of document and this very document number, (3) for a document that belongs to the requested client,
-- (4) not older than 24 hours since the decision, and (5) single-use: the same statement checks and consumes it, under a row lock.
-- The internal view and print of an office_sales (REQUIREMENTS-V1 §16.1) is another path and is not changed.
CREATE FUNCTION public.consume_document_copy(p_id uuid, p_kind text, p_doc_ref text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v public.document_request%ROWTYPE;
  v_belongs boolean;
BEGIN
  SELECT * INTO v FROM public.document_request d WHERE d.id = p_id FOR UPDATE;
  IF NOT FOUND OR ctx.user_id() IS NULL OR v.requester <> ctx.user_id() OR v.status <> 'approved'
     OR v.kind IS DISTINCT FROM p_kind OR v.doc_ref IS DISTINCT FROM p_doc_ref OR v.party_kind <> 'client'
     OR v.decided_at IS NULL OR v.decided_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'consume_document_copy: not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_belongs := CASE p_kind
    WHEN 'invoice_copy' THEN EXISTS (SELECT 1 FROM public.invoice i JOIN public.client c ON c.id = i.client_id WHERE i.number = p_doc_ref AND c.code = v.party_code)
    WHEN 'avoir_copy'   THEN EXISTS (SELECT 1 FROM public.avoir a JOIN public.client c ON c.id = a.client_id WHERE a.number = p_doc_ref AND c.code = v.party_code)
    WHEN 'quote_copy'   THEN EXISTS (SELECT 1 FROM public.quote q JOIN public.client c ON c.id = q.client_id WHERE q.code = p_doc_ref AND c.code = v.party_code)
    WHEN 'bl_copy'      THEN EXISTS (SELECT 1 FROM public.delivery d JOIN public.sales_order o ON o.id = d.order_id JOIN public.client c ON c.id = o.client_id WHERE d.bl_no = p_doc_ref AND c.code = v.party_code)
    ELSE false END;
  IF NOT v_belongs THEN
    RAISE EXCEPTION 'consume_document_copy: the document is not the requested client''s' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.document_request d SET status = 'used', used_at = now() WHERE d.id = p_id;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.consume_document_copy(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.consume_document_copy(uuid, text, text) TO belgobeton_app;
--> statement-breakpoint
-- The release of a statement-type request (releve, supplier_statement) expires too.
CREATE OR REPLACE FUNCTION public.use_document_request(p_id uuid) RETURNS TABLE(kind text, party_kind text, party_code text, doc_ref text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.document_request%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.document_request d WHERE d.id = p_id FOR UPDATE;
  IF NOT FOUND OR v.requester <> ctx.user_id() OR v.status <> 'approved' OR v.decided_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'use_document_request: not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v.kind NOT IN ('releve', 'supplier_statement') THEN
    RAISE EXCEPTION 'use_document_request: a document copy is released by its download' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.document_request d SET status = 'used', used_at = now() WHERE d.id = p_id;
  RETURN QUERY SELECT v.kind, v.party_kind, v.party_code, v.doc_ref;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.my_document_requests() RETURNS TABLE(id uuid, kind text, party_kind text, party_code text, doc_ref text, status text, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.kind, d.party_kind, d.party_code, d.doc_ref,
         CASE WHEN d.status = 'approved' AND d.decided_at < now() - interval '24 hours' THEN 'expired' ELSE d.status END, d.created_at
    FROM public.document_request d WHERE d.requester = ctx.user_id() ORDER BY d.created_at DESC LIMIT 50
$$;
