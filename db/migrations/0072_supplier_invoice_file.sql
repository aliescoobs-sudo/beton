-- integration I2.3 (SPEC-integration AC-INT-15): the photo (or PDF) of the supplier's invoice, stored as an attachment of the
-- invoice, with the rules of every stored document (src/lib/files: type and magic bytes, metadata stripped, sealed at rest,
-- served by a route that re-checks RLS, every view audited). The row is written by one door, `attach_supplier_invoice_file`,
-- which office can call blind (it names the invoice by our code and learns nothing else); owner and support read.
CREATE TABLE public.supplier_invoice_file (
  -- Also the name of the sealed file in the store.
  id                  uuid PRIMARY KEY,
  supplier_invoice_id uuid    NOT NULL REFERENCES public.supplier_invoice (id),
  seq                 integer NOT NULL CHECK (seq BETWEEN 1 AND 5),
  content_type        text    NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes          integer NOT NULL CHECK (size_bytes > 0),
  -- SHA-256 of what was stored (after the metadata was removed), to show the file was not swapped.
  sha256              text    NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by          uuid    NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_invoice_id, seq)
);
--> statement-breakpoint
ALTER TABLE public.supplier_invoice_file ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.supplier_invoice_file FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.supplier_invoice_file FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.supplier_invoice_file TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY supplier_invoice_file_read ON public.supplier_invoice_file FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY supplier_invoice_file_definer_read ON public.supplier_invoice_file FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY supplier_invoice_file_definer_insert ON public.supplier_invoice_file FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.supplier_invoice_file');
--> statement-breakpoint
SELECT audit.attach('public.supplier_invoice_file');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line', 'quote',
                     'alert', 'alert_event', 'cash_decision', 'fuel_purchase', 'invoice_advance', 'avoir',
                     'supplier_invoice', 'supplier_invoice_line', 'supplier_invoice_receipt', 'supplier_invoice_event',
                     'supplier_invoice_file')
$$;
--> statement-breakpoint

-- Attaches a stored document to an invoice, by our code: an invoice not rejected, at most five documents. The bytes are sealed by
-- the caller under `p_file`. Returns false (audited, one answer) for an unknown or rejected invoice or a sixth document.
CREATE FUNCTION public.attach_supplier_invoice_file(p_code text, p_file uuid, p_type text, p_size integer, p_sha text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.role();
  v_si   uuid;
  v_seq  integer;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'attach_supplier_invoice_file: role % may not attach a document', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.id INTO v_si FROM public.supplier_invoice s
   WHERE s.code = p_code AND public._supplier_invoice_state(s.id) <> 'rejected';
  IF v_si IS NULL THEN
    PERFORM audit.record('permission_denied', 'supplier_invoice_create', left(coalesce(p_code, ''), 40), NULL, NULL, 'unknown or rejected invoice (document)');
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_invoice:file:' || v_si::text, 0));
  SELECT coalesce(max(f.seq), 0) + 1 INTO v_seq FROM public.supplier_invoice_file f WHERE f.supplier_invoice_id = v_si;
  IF v_seq > 5 THEN
    PERFORM audit.record('permission_denied', 'supplier_invoice_create', left(p_code, 40), NULL, NULL, 'more than five documents');
    RETURN false;
  END IF;
  INSERT INTO public.supplier_invoice_file (id, supplier_invoice_id, seq, content_type, size_bytes, sha256, created_by)
  VALUES (p_file, v_si, v_seq, p_type, p_size, p_sha, ctx.user_id());
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.attach_supplier_invoice_file(text, uuid, text, integer, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.attach_supplier_invoice_file(text, uuid, text, integer, text) TO belgobeton_app;
