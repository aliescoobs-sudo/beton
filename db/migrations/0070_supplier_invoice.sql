-- integration I2.1 (SPEC-integration AC-INT-13): the supplier's invoice is its own document, linked to one purchase order and to
-- the receipts it covers. Until now the purchase carried an invoice number and a date; now the invoice has its lines (quantity and
-- price as the supplier wrote them), its totals and its own events (entered, gaps accepted, approved, rejected), and the receipts
-- it covers are named. It is entered through one door (`create_supplier_invoice`): the owner or office (blind: the answer is the
-- code), the database links each line to the purchase line of the same component and computes the totals. The match against the
-- order and the receipts, the approval and the payable come in I2.2. Money: owner and support read; nobody inserts directly.

CREATE TABLE public.supplier_invoice (
  id                  uuid PRIMARY KEY,
  -- Our reference, FF-YYYY-nnnnn from the document counter (the supplier's own number is below).
  code                text   NOT NULL UNIQUE CHECK (code ~ '^FF-[0-9]{4}-[0-9]{5,}$'),
  purchase_id         uuid   NOT NULL REFERENCES public.purchase (id),
  supplier_id         uuid   NOT NULL REFERENCES public.supplier (id),
  supplier_invoice_no text   NOT NULL CHECK (supplier_invoice_no = btrim(supplier_invoice_no) AND length(supplier_invoice_no) BETWEEN 1 AND 60),
  invoice_date        date   NOT NULL,
  -- Law 69-21: at most 120 days after the supplier's invoice date.
  due_date            date   NOT NULL,
  vat_rate_bp         integer NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  total_ht_centimes   bigint NOT NULL CHECK (total_ht_centimes > 0),
  total_vat_centimes  bigint NOT NULL CHECK (total_vat_centimes >= 0),
  total_ttc_centimes  bigint NOT NULL,
  created_by          uuid   NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (total_ttc_centimes = total_ht_centimes + total_vat_centimes),
  CHECK (due_date >= invoice_date AND due_date <= invoice_date + 120)
);
--> statement-breakpoint
CREATE INDEX supplier_invoice_purchase_idx ON public.supplier_invoice (purchase_id);
--> statement-breakpoint
CREATE INDEX supplier_invoice_supplier_idx ON public.supplier_invoice (supplier_id);
--> statement-breakpoint
CREATE TABLE public.supplier_invoice_line (
  id                     uuid PRIMARY KEY,
  supplier_invoice_id    uuid    NOT NULL REFERENCES public.supplier_invoice (id),
  seq                    integer NOT NULL CHECK (seq >= 1),
  -- The purchase line it bills (the line of the same component), or null for a line the order does not have.
  purchase_line_id       uuid    REFERENCES public.purchase_line (id),
  component_id           uuid    REFERENCES public.component (id),
  description            text    CHECK (description = btrim(description) AND length(description) BETWEEN 1 AND 200),
  -- Thousandths of the unit of the purchase line (2,5 t = 2500), as the supplier wrote them.
  qty_milli              bigint  NOT NULL CHECK (qty_milli > 0),
  unit_price_ht_centimes bigint  NOT NULL CHECK (unit_price_ht_centimes > 0),
  line_ht_centimes       bigint  NOT NULL CHECK (line_ht_centimes > 0),
  created_by             uuid    NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_invoice_id, seq),
  CHECK (component_id IS NOT NULL OR description IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX supplier_invoice_line_pline_idx ON public.supplier_invoice_line (purchase_line_id);
--> statement-breakpoint
-- The receipts the invoice covers: those of its order, each by at most one live invoice.
CREATE TABLE public.supplier_invoice_receipt (
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoice (id),
  purchase_receipt_id uuid NOT NULL REFERENCES public.purchase_receipt (id),
  created_by          uuid NOT NULL,
  PRIMARY KEY (supplier_invoice_id, purchase_receipt_id)
);
--> statement-breakpoint
-- What happened to the invoice: entered, then (optionally) gaps accepted, then approved or rejected. Insert-only.
CREATE TABLE public.supplier_invoice_event (
  id                  uuid PRIMARY KEY,
  supplier_invoice_id uuid   NOT NULL REFERENCES public.supplier_invoice (id),
  seq                 integer NOT NULL CHECK (seq >= 1),
  event               text   NOT NULL CHECK (event IN ('entered', 'gaps_accepted', 'approved', 'rejected')),
  reason              text   CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by          uuid   NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_invoice_id, seq),
  CHECK (event IN ('entered', 'approved') OR reason IS NOT NULL)
);
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_invoice', 'supplier_invoice_line', 'supplier_invoice_receipt', 'supplier_invoice_event'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''owner'')', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_migrator USING (true)', t || '_definer_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO belgobeton_migrator WITH CHECK (true)', t || '_definer_insert', t);
    EXECUTE format('SELECT public.grant_support_read(%L)', 'public.' || t);
    EXECUTE format('SELECT audit.attach(%L)', 'public.' || t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line', 'quote',
                     'alert', 'alert_event', 'cash_decision', 'fuel_purchase', 'invoice_advance', 'avoir',
                     'supplier_invoice', 'supplier_invoice_line', 'supplier_invoice_receipt', 'supplier_invoice_event')
$$;
--> statement-breakpoint

-- The guard on a line: its purchase line belongs to the order of the invoice and agrees with its component; the total is
-- quantity times price, rounded once (the same rule as the purchase lines).
CREATE FUNCTION public.supplier_invoice_line_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_si public.supplier_invoice%ROWTYPE;
BEGIN
  SELECT * INTO v_si FROM public.supplier_invoice WHERE id = NEW.supplier_invoice_id;
  IF NEW.purchase_line_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.purchase_line l
        WHERE l.id = NEW.purchase_line_id AND l.purchase_id = v_si.purchase_id AND l.component_id IS NOT DISTINCT FROM NEW.component_id) THEN
    RAISE EXCEPTION 'supplier_invoice_line: not a line of the order of this invoice' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.line_ht_centimes <> public.scale_qty(NEW.unit_price_ht_centimes, NEW.qty_milli, 1000) THEN
    RAISE EXCEPTION 'supplier_invoice_line: the line total is not quantity times price' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER supplier_invoice_line_guard BEFORE INSERT ON public.supplier_invoice_line
  FOR EACH ROW EXECUTE FUNCTION public.supplier_invoice_line_guard();
--> statement-breakpoint

-- At commit: an invoice has lines and they add up to its total HT.
CREATE FUNCTION public.supplier_invoice_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id    uuid;
  v_si    public.supplier_invoice%ROWTYPE;
  v_lines bigint;
  v_n     integer;
BEGIN
  IF TG_TABLE_NAME = 'supplier_invoice' THEN
    v_id := NEW.id;
  ELSE
    v_id := NEW.supplier_invoice_id;
  END IF;
  SELECT * INTO v_si FROM public.supplier_invoice WHERE id = v_id;
  SELECT coalesce(sum(l.line_ht_centimes), 0), count(*) INTO v_lines, v_n
    FROM public.supplier_invoice_line l WHERE l.supplier_invoice_id = v_id;
  IF v_n = 0 OR v_lines <> v_si.total_ht_centimes THEN
    RAISE EXCEPTION 'lines of supplier invoice % add up to %, the total HT is %', v_si.code, v_lines, v_si.total_ht_centimes
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER supplier_invoice_balanced AFTER INSERT ON public.supplier_invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.supplier_invoice_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER supplier_invoice_line_balanced AFTER INSERT ON public.supplier_invoice_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.supplier_invoice_balanced();
--> statement-breakpoint

-- The one door in. `p_lines` is a JSON array of {componentId | description, qtyMilli, unitPriceHtCentimes}; the quantity is in the
-- unit of the purchase line of the same component. Returns our code, or NULL (unknown order, a supplier number already entered
-- and not rejected, bad lines or dates): one answer, audited, ten in ten minutes lock the actor out. Nothing else comes back.
CREATE FUNCTION public.create_supplier_invoice(
  p_purchase_code text, p_no text, p_invoice_date date, p_due date, p_lines jsonb, p_receipts uuid[], p_today date
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role   text := ctx.role();
  v_user   uuid := ctx.user_id();
  v_fails  integer;
  v_po     public.purchase%ROWTYPE;
  v_no     text := btrim(coalesce(p_no, ''));
  v_due    date;
  v_id     uuid := gen_random_uuid();
  v_code   text;
  v_row    jsonb;
  v_seq    integer := 0;
  v_comp   uuid;
  v_desc   text;
  v_qty    bigint;
  v_price  bigint;
  v_pline  uuid;
  v_used   uuid[] := '{}';
  v_ht     bigint := 0;
  v_vat    bigint;
  v_rec    uuid;
  v_recs   uuid[];
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'create_supplier_invoice: role % may not enter a supplier invoice', coalesce(v_role, '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO v_fails FROM public.audit_event e
   WHERE e.actor_user_id = v_user AND e.table_name = 'supplier_invoice_create' AND e.action = 'permission_denied'
     AND e.at > clock_timestamp() - interval '10 minutes';
  IF v_fails >= 10 THEN
    RAISE EXCEPTION 'create_supplier_invoice: too many failed attempts, try again later' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_due := coalesce(p_due, p_invoice_date + 60);
  SELECT * INTO v_po FROM public.purchase p
   WHERE p.code = p_purchase_code AND p.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.purchase r WHERE r.reverses_id = p.id);
  IF NOT FOUND OR length(v_no) NOT BETWEEN 1 AND 60 OR p_invoice_date IS NULL OR p_today IS NULL OR p_invoice_date > p_today
     OR v_due < p_invoice_date OR v_due > p_invoice_date + 120
     OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 50 THEN
    PERFORM audit.record('permission_denied', 'supplier_invoice_create', left(coalesce(p_purchase_code, ''), 40), NULL, NULL,
                         'unknown order or invalid entry');
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_invoice:' || v_po.supplier_id::text || ':' || lower(v_no), 0));
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice s
     WHERE s.supplier_id = v_po.supplier_id AND lower(s.supplier_invoice_no) = lower(v_no)
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = s.id AND e.event = 'rejected')
  ) THEN
    PERFORM audit.record('permission_denied', 'supplier_invoice_create', left(p_purchase_code, 40), NULL, NULL,
                         'supplier invoice number already entered');
    RETURN NULL;
  END IF;

  v_code := public.next_doc_number('FF', extract(year FROM p_today)::integer, 5);
  -- The totals first (the header row needs them), then the lines.
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_qty := (v_row ->> 'qtyMilli')::bigint;
    v_price := (v_row ->> 'unitPriceHtCentimes')::bigint;
    IF v_qty IS NULL OR v_qty <= 0 OR v_price IS NULL OR v_price <= 0 THEN
      PERFORM audit.record('permission_denied', 'supplier_invoice_create', left(p_purchase_code, 40), NULL, NULL, 'invalid line');
      RETURN NULL;
    END IF;
    v_ht := v_ht + public.scale_qty(v_price, v_qty, 1000);
  END LOOP;
  v_vat := public.scale_qty(v_ht, v_po.vat_rate_bp, 10000);
  INSERT INTO public.supplier_invoice (id, code, purchase_id, supplier_id, supplier_invoice_no, invoice_date, due_date,
                                       vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
  VALUES (v_id, v_code, v_po.id, v_po.supplier_id, v_no, p_invoice_date, v_due, v_po.vat_rate_bp, v_ht, v_vat, v_ht + v_vat, v_user);

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_seq := v_seq + 1;
    v_comp := nullif(v_row ->> 'componentId', '')::uuid;
    v_desc := nullif(btrim(coalesce(v_row ->> 'description', '')), '');
    v_qty := (v_row ->> 'qtyMilli')::bigint;
    v_price := (v_row ->> 'unitPriceHtCentimes')::bigint;
    v_pline := NULL;
    IF v_comp IS NOT NULL THEN
      -- The purchase line of the same component, in order, each one billed by at most one line of this invoice.
      SELECT l.id INTO v_pline FROM public.purchase_line l
       WHERE l.purchase_id = v_po.id AND l.component_id = v_comp AND NOT (l.id = ANY (v_used))
       ORDER BY l.seq LIMIT 1;
      IF v_pline IS NOT NULL THEN
        v_used := v_used || v_pline;
      END IF;
      IF v_desc IS NULL THEN
        SELECT c.name_fr INTO v_desc FROM public.component c WHERE c.id = v_comp;
      END IF;
    END IF;
    INSERT INTO public.supplier_invoice_line (id, supplier_invoice_id, seq, purchase_line_id, component_id, description, qty_milli,
                                              unit_price_ht_centimes, line_ht_centimes, created_by)
    VALUES (gen_random_uuid(), v_id, v_seq, v_pline, v_comp, v_desc, v_qty, v_price,
            public.scale_qty(v_price, v_qty, 1000), v_user);
  END LOOP;

  -- The receipts it covers: the ones named, else every receipt of the order no live invoice covers yet.
  IF p_receipts IS NULL THEN
    SELECT coalesce(array_agg(r.id), '{}') INTO v_recs FROM public.purchase_receipt r
     WHERE r.purchase_id = v_po.id
       AND NOT EXISTS (
         SELECT 1 FROM public.supplier_invoice_receipt x JOIN public.supplier_invoice s ON s.id = x.supplier_invoice_id
          WHERE x.purchase_receipt_id = r.id
            AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = s.id AND e.event = 'rejected'));
  ELSE
    v_recs := p_receipts;
  END IF;
  FOREACH v_rec IN ARRAY v_recs LOOP
    IF NOT EXISTS (SELECT 1 FROM public.purchase_receipt r WHERE r.id = v_rec AND r.purchase_id = v_po.id) THEN
      PERFORM audit.record('permission_denied', 'supplier_invoice_create', left(p_purchase_code, 40), NULL, NULL,
                           'a receipt that is not of this order');
      RAISE EXCEPTION 'create_supplier_invoice: a receipt that is not of this order' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.supplier_invoice_receipt (supplier_invoice_id, purchase_receipt_id, created_by) VALUES (v_id, v_rec, v_user);
  END LOOP;
  INSERT INTO public.supplier_invoice_event (id, supplier_invoice_id, seq, event, created_by)
  VALUES (gen_random_uuid(), v_id, 1, 'entered', v_user);
  RETURN v_code;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_supplier_invoice(text, text, date, date, jsonb, uuid[], date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_supplier_invoice(text, text, date, date, jsonb, uuid[], date) TO belgobeton_app;
