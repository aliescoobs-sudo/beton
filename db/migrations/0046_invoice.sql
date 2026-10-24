-- ledger L17 (AC-LED-08, 09, 15; law 69-21): the internal invoice, built from the loads of an order. Insert-only (a credit
-- note, L18, is a reversing row with its own number), gapless FA-YYYY-nnnnn numbers from the document counter, the client's
-- name and ICE and the VAT rate copied at creation, due date at most 120 days after the invoice date. Office creates
-- blind; owner and support read; partner and plant have nothing. The sources an invoice needs (the order's price and
-- client, its uninvoiced loads) are read by one reviewed SECURITY DEFINER function for the roles that cannot read orders.

CREATE TABLE public.invoice (
  id             uuid PRIMARY KEY,
  number         text   NOT NULL UNIQUE CHECK (number ~ '^FA-[0-9]{4}-[0-9]{5,}$'),
  order_id       uuid   NOT NULL REFERENCES public.sales_order (id),
  client_id      uuid   NOT NULL REFERENCES public.client (id),
  -- Copied from the client when the invoice is issued: the document never changes with the master data.
  client_name    text   NOT NULL CHECK (client_name = btrim(client_name) AND length(client_name) BETWEEN 1 AND 200),
  client_ice     text   CHECK (client_ice IS NULL OR client_ice ~ '^[0-9]{15}$'),
  invoice_date   date   NOT NULL,
  -- Law 69-21: an invoice is issued by the end of the month of the delivery.
  issue_deadline date   NOT NULL,
  due_date       date   NOT NULL,
  vat_rate_bp    integer NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  total_ht_centimes  bigint NOT NULL,
  total_vat_centimes bigint NOT NULL,
  total_ttc_centimes bigint NOT NULL,
  -- A credit note (L18) negates its invoice and keeps its own number; the invoice is never edited.
  credit_note_of uuid   UNIQUE REFERENCES public.invoice (id),
  reason         text   CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by     uuid   NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (total_ttc_centimes = total_ht_centimes + total_vat_centimes),
  CHECK (due_date >= invoice_date AND due_date <= invoice_date + 120),
  CHECK (
    (credit_note_of IS NULL AND total_ttc_centimes > 0)
    OR (credit_note_of IS NOT NULL AND total_ttc_centimes < 0 AND reason IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX invoice_order_idx ON public.invoice (order_id);
--> statement-breakpoint
CREATE INDEX invoice_client_idx ON public.invoice (client_id);
--> statement-breakpoint
CREATE TABLE public.invoice_line (
  id          uuid PRIMARY KEY,
  invoice_id  uuid    NOT NULL REFERENCES public.invoice (id),
  seq         integer NOT NULL CHECK (seq >= 1),
  -- The load this line invoices (the BL number is in the description); a line without a load is not allowed in the MVP.
  delivery_id uuid    NOT NULL REFERENCES public.delivery (id),
  description text    NOT NULL CHECK (description = btrim(description) AND length(description) BETWEEN 1 AND 300),
  -- Litres; negative on a credit note.
  volume_l    integer NOT NULL CHECK (volume_l <> 0),
  unit_price_ht_centimes bigint NOT NULL CHECK (unit_price_ht_centimes > 0),
  line_ht_centimes       bigint NOT NULL CHECK (line_ht_centimes <> 0),
  created_by  uuid    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, seq),
  CHECK ((volume_l > 0) = (line_ht_centimes > 0))
);
--> statement-breakpoint
CREATE INDEX invoice_line_delivery_idx ON public.invoice_line (delivery_id);
--> statement-breakpoint

CREATE POLICY invoice_definer_read ON public.invoice FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY invoice_line_definer_read ON public.invoice_line FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- Guard on an invoice: an original belongs to a live order and to that order's client; a credit note negates its invoice
-- exactly, once, and a credit note cannot itself be credited.
CREATE FUNCTION public.invoice_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order public.sales_order%ROWTYPE;
  v_orig  public.invoice%ROWTYPE;
BEGIN
  IF NEW.credit_note_of IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.invoice i WHERE i.id = NEW.credit_note_of;
    IF NOT FOUND OR v_orig.credit_note_of IS NOT NULL THEN
      RAISE EXCEPTION 'invoice: a credit note credits an original invoice' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.order_id <> v_orig.order_id OR NEW.client_id <> v_orig.client_id OR NEW.client_name <> v_orig.client_name
       OR NEW.client_ice IS DISTINCT FROM v_orig.client_ice OR NEW.vat_rate_bp <> v_orig.vat_rate_bp
       OR NEW.total_ht_centimes <> -v_orig.total_ht_centimes OR NEW.total_vat_centimes <> -v_orig.total_vat_centimes
       OR NEW.total_ttc_centimes <> -v_orig.total_ttc_centimes THEN
      RAISE EXCEPTION 'invoice: a credit note negates its invoice exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_order FROM public.sales_order o WHERE o.id = NEW.order_id;
  IF NOT FOUND OR v_order.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'invoice: unknown order' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = v_order.id) THEN
    RAISE EXCEPTION 'invoice: the order is cancelled' USING ERRCODE = 'check_violation';
  END IF;
  IF v_order.client_id <> NEW.client_id THEN
    RAISE EXCEPTION 'invoice: not the client of the order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.vat_rate_bp <> v_order.vat_rate_bp THEN
    RAISE EXCEPTION 'invoice: not the VAT rate of the order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.total_vat_centimes <> public.scale_qty(NEW.total_ht_centimes, NEW.vat_rate_bp, 10000) THEN
    RAISE EXCEPTION 'invoice: VAT is not the rate on the total HT' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_guard BEFORE INSERT ON public.invoice
  FOR EACH ROW EXECUTE FUNCTION public.invoice_guard();
--> statement-breakpoint

-- Guard on a line: an original line invoices one live load of the invoice's order, once; the line total is the volume times
-- the order's unit price rounded once. A credit-note line negates the line of the same rank.
CREATE FUNCTION public.invoice_line_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i    public.invoice%ROWTYPE;
  v_d    public.delivery%ROWTYPE;
  v_o    public.sales_order%ROWTYPE;
  v_orig public.invoice_line%ROWTYPE;
BEGIN
  SELECT * INTO v_i FROM public.invoice i WHERE i.id = NEW.invoice_id;
  IF v_i.credit_note_of IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.invoice_line l WHERE l.invoice_id = v_i.credit_note_of AND l.seq = NEW.seq;
    IF NOT FOUND OR NEW.delivery_id <> v_orig.delivery_id OR NEW.volume_l <> -v_orig.volume_l
       OR NEW.line_ht_centimes <> -v_orig.line_ht_centimes OR NEW.unit_price_ht_centimes <> v_orig.unit_price_ht_centimes
       OR NEW.description <> v_orig.description THEN
      RAISE EXCEPTION 'invoice_line: a credit line negates the line of its invoice' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice:delivery:' || NEW.delivery_id::text, 0));
  SELECT * INTO v_d FROM public.delivery d WHERE d.id = NEW.delivery_id;
  IF NOT FOUND OR v_d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = v_d.id) THEN
    RAISE EXCEPTION 'invoice_line: not a live load' USING ERRCODE = 'check_violation';
  END IF;
  IF v_d.order_id <> v_i.order_id THEN
    RAISE EXCEPTION 'invoice_line: the load is not a load of the invoice''s order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.volume_l <> v_d.volume_l THEN
    RAISE EXCEPTION 'invoice_line: not the volume of the load' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_o FROM public.sales_order o WHERE o.id = v_i.order_id;
  IF NEW.unit_price_ht_centimes <> v_o.unit_price_ht_centimes THEN
    RAISE EXCEPTION 'invoice_line: not the unit price of the order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.line_ht_centimes <> public.scale_qty(NEW.unit_price_ht_centimes, NEW.volume_l, 1000) THEN
    RAISE EXCEPTION 'invoice_line: the line total is not volume times price' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoice_line l JOIN public.invoice i ON i.id = l.invoice_id
     WHERE l.delivery_id = NEW.delivery_id AND i.credit_note_of IS NULL AND i.id <> NEW.invoice_id
       AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id)
  ) THEN
    RAISE EXCEPTION 'invoice_line: the load is already invoiced' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_line_guard BEFORE INSERT ON public.invoice_line
  FOR EACH ROW EXECUTE FUNCTION public.invoice_line_guard();
--> statement-breakpoint

-- At commit: an invoice has lines and they add up to its total HT.
CREATE FUNCTION public.invoice_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id    uuid;
  v_i     public.invoice%ROWTYPE;
  v_lines bigint;
  v_n     integer;
BEGIN
  IF TG_TABLE_NAME = 'invoice' THEN
    v_id := NEW.id;
  ELSE
    v_id := NEW.invoice_id;
  END IF;
  SELECT * INTO v_i FROM public.invoice i WHERE i.id = v_id;
  SELECT coalesce(sum(l.line_ht_centimes), 0), count(*) INTO v_lines, v_n FROM public.invoice_line l WHERE l.invoice_id = v_id;
  IF v_n = 0 OR v_lines <> v_i.total_ht_centimes THEN
    RAISE EXCEPTION 'lines of invoice % add up to %, the total HT is %', v_i.number, v_lines, v_i.total_ht_centimes
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER invoice_balanced AFTER INSERT ON public.invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.invoice_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER invoice_line_balanced AFTER INSERT ON public.invoice_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.invoice_balanced();
--> statement-breakpoint

ALTER TABLE public.invoice ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.invoice FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.invoice_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.invoice_line FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.invoice, public.invoice_line FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.invoice, public.invoice_line TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY invoice_read ON public.invoice FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY invoice_insert ON public.invoice FOR INSERT TO belgobeton_app
  WITH CHECK (
    created_by = ctx.user_id() AND (
      (ctx.role() IN ('owner', 'office') AND credit_note_of IS NULL AND reason IS NULL)
      OR (ctx.role() = 'owner' AND credit_note_of IS NOT NULL AND reason IS NOT NULL)
    )
  );
--> statement-breakpoint
CREATE POLICY invoice_line_read ON public.invoice_line FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY invoice_line_insert ON public.invoice_line FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'office') AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.invoice');
--> statement-breakpoint
SELECT public.grant_support_read('public.invoice_line');
--> statement-breakpoint
SELECT audit.attach('public.invoice');
--> statement-breakpoint
SELECT audit.attach('public.invoice_line');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line')
$$;
--> statement-breakpoint

-- What an invoice is made of, for the roles that create one and cannot read orders (office): found by the order's code, the
-- order's client and unit price and its loads that no live invoice covers yet. Used server-side to build the lines; office is never shown the
-- price (the same deliberate door as resolve_selling_price, DECISIONS 81 answer A).
CREATE FUNCTION public.invoice_source(p_order_code text)
RETURNS TABLE (
  order_id uuid, order_code text, type_code text, client_id uuid, client_code text, client_name text, client_ice text, unit_price_ht_centimes bigint,
  vat_rate_bp integer, delivery_id uuid, bl_no text, load_date date, volume_l integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'invoice_source: role % may not read an invoice source', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT o.id, o.code, t.code, c.id, c.code, c.name, c.ice, o.unit_price_ht_centimes, o.vat_rate_bp, d.id, d.bl_no, d.load_date, d.volume_l
      FROM public.sales_order o
      JOIN public.client c ON c.id = o.client_id
      JOIN public.concrete_type t ON t.id = o.concrete_type_id
      JOIN public.delivery d ON d.order_id = o.id AND d.reverses_id IS NULL
     WHERE o.code = p_order_code AND o.reverses_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.invoice_line l JOIN public.invoice i ON i.id = l.invoice_id
          WHERE l.delivery_id = d.id AND i.credit_note_of IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.invoice cn WHERE cn.credit_note_of = i.id))
     ORDER BY d.load_date, d.bl_no;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.invoice_source(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.invoice_source(text) TO belgobeton_app;
