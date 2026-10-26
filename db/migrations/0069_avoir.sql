-- integration I1.6 (SPEC-integration AC-INT-12; DECISIONS 93, 94): the avoir (credit note) for concrete that was refused or
-- brought back after it was billed. Owner only, step-up 2FA, own AV-YYYY-nnnnn numbers; it references the invoice, the BL and
-- the loss record and never edits the invoice (a separate document). It credits the load's lost litres at the invoice line's
-- price, and the credit is applied onto the plan items of the BL's order (as allocation rows with no instrument, tagged with
-- the invoice), which lowers what the client owes: statement, forecast and invoice state all follow.

CREATE TABLE public.avoir (
  id                     uuid PRIMARY KEY,
  number                 text   NOT NULL UNIQUE CHECK (number ~ '^AV-[0-9]{4}-[0-9]{5,}$'),
  invoice_id             uuid   NOT NULL REFERENCES public.invoice (id),
  delivery_id            uuid   NOT NULL REFERENCES public.delivery (id),
  -- One avoir per loss record: the litres lost are credited once.
  loss_id                uuid   NOT NULL UNIQUE REFERENCES public.delivery_loss (id),
  client_id              uuid   NOT NULL REFERENCES public.client (id),
  avoir_date             date   NOT NULL,
  volume_l               integer NOT NULL CHECK (volume_l > 0),
  unit_price_ht_centimes bigint NOT NULL CHECK (unit_price_ht_centimes > 0),
  vat_rate_bp            integer NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  total_ht_centimes      bigint NOT NULL CHECK (total_ht_centimes > 0),
  total_vat_centimes     bigint NOT NULL CHECK (total_vat_centimes >= 0),
  total_ttc_centimes     bigint NOT NULL,
  reason                 text   NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  created_by             uuid   NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (total_ttc_centimes = total_ht_centimes + total_vat_centimes)
);
--> statement-breakpoint
CREATE INDEX avoir_invoice_idx ON public.avoir (invoice_id);
--> statement-breakpoint
CREATE INDEX avoir_client_idx ON public.avoir (client_id);
--> statement-breakpoint
ALTER TABLE public.avoir ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.avoir FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.avoir FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.avoir TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY avoir_read ON public.avoir FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY avoir_definer_read ON public.avoir FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY avoir_definer_insert ON public.avoir FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.avoir');
--> statement-breakpoint
SELECT audit.attach('public.avoir');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line', 'quote',
                     'alert', 'alert_event', 'cash_decision', 'fuel_purchase', 'invoice_advance', 'avoir')
$$;
--> statement-breakpoint

-- The guard: an avoir credits the lost litres of a BL that a live invoice bills, at that line's price and VAT, with the
-- amounts the database computes (one rounding per figure).
CREATE FUNCTION public.avoir_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i    public.invoice%ROWTYPE;
  v_line public.invoice_line%ROWTYPE;
  v_loss public.delivery_loss%ROWTYPE;
  v_ht   bigint;
BEGIN
  SELECT * INTO v_i FROM public.invoice WHERE id = NEW.invoice_id;
  IF NOT FOUND OR v_i.credit_note_of IS NOT NULL OR EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = v_i.id) THEN
    RAISE EXCEPTION 'avoir: not a live invoice' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_line FROM public.invoice_line l WHERE l.invoice_id = v_i.id AND l.delivery_id = NEW.delivery_id;
  SELECT * INTO v_loss FROM public.delivery_loss l WHERE l.id = NEW.loss_id;
  IF v_line.id IS NULL OR v_loss.id IS NULL OR v_loss.delivery_id <> NEW.delivery_id THEN
    RAISE EXCEPTION 'avoir: the invoice does not bill this load, or the loss is not of this load' USING ERRCODE = 'check_violation';
  END IF;
  v_ht := public.scale_qty(v_line.unit_price_ht_centimes, v_loss.volume_l, 1000);
  IF NEW.client_id <> v_i.client_id OR NEW.volume_l <> v_loss.volume_l OR NEW.unit_price_ht_centimes <> v_line.unit_price_ht_centimes
     OR NEW.vat_rate_bp <> v_i.vat_rate_bp OR NEW.total_ht_centimes <> v_ht
     OR NEW.total_vat_centimes <> public.scale_qty(v_ht, v_i.vat_rate_bp, 10000) THEN
    RAISE EXCEPTION 'avoir: not the lost litres at the price and VAT of the invoice line' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER avoir_guard BEFORE INSERT ON public.avoir FOR EACH ROW EXECUTE FUNCTION public.avoir_guard();
--> statement-breakpoint

-- Credit applied onto plan items: allocation rows with an avoir instead of an instrument.
ALTER TABLE public.allocation ALTER COLUMN instrument_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.allocation ADD COLUMN avoir_id uuid REFERENCES public.avoir (id);
--> statement-breakpoint
ALTER TABLE public.allocation ADD CONSTRAINT allocation_instrument_or_avoir
  CHECK ((instrument_id IS NULL) <> (avoir_id IS NULL));
--> statement-breakpoint
ALTER TABLE public.allocation ADD CONSTRAINT allocation_avoir_on_plan_items
  CHECK (avoir_id IS NULL OR (payment_plan_item_id IS NOT NULL AND reverses_id IS NULL));
--> statement-breakpoint
CREATE INDEX allocation_avoir_idx ON public.allocation (avoir_id) WHERE avoir_id IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.allocation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i      public.payment_instrument%ROWTYPE;
  v_item   public.payment_plan_item%ROWTYPE;
  v_pitem  public.purchase_plan_item%ROWTYPE;
  v_orig   public.allocation%ROWTYPE;
  v_state  text;
  v_sum    bigint;
  v_av     public.avoir%ROWTYPE;
  v_target uuid := coalesce(NEW.payment_plan_item_id, NEW.purchase_plan_item_id);
BEGIN
  IF NEW.avoir_id IS NOT NULL THEN
    -- Credit applied by an avoir (integration I1.6): onto a plan item of the order of the credited load, never more than the
    -- avoir, never more than the item, for the avoir's client; tagged with the avoir's invoice or not at all.
    PERFORM pg_advisory_xact_lock(hashtextextended('allocation:avoir:' || NEW.avoir_id::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || NEW.payment_plan_item_id::text, 0));
    SELECT * INTO v_av FROM public.avoir WHERE id = NEW.avoir_id;
    SELECT * INTO v_item FROM public.payment_plan_item WHERE id = NEW.payment_plan_item_id;
    IF v_av.id IS NULL OR v_item.id IS NULL OR v_item.reverses_id IS NOT NULL OR v_item.direction <> 'in'
       OR NEW.reverses_id IS NOT NULL OR NEW.amount_centimes <= 0
       OR NOT EXISTS (SELECT 1 FROM public.delivery d WHERE d.id = v_av.delivery_id AND d.order_id = v_item.order_id)
       OR (SELECT o.client_id FROM public.sales_order o WHERE o.id = v_item.order_id) <> v_av.client_id
       OR (NEW.invoice_id IS NOT NULL AND NEW.invoice_id <> v_av.invoice_id) THEN
      RAISE EXCEPTION 'allocation: not a plan item the avoir may credit' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a.amount_centimes), 0) INTO v_sum FROM public.allocation a WHERE a.avoir_id = v_av.id;
    IF v_sum + NEW.amount_centimes > v_av.total_ttc_centimes THEN
      RAISE EXCEPTION 'allocation: more than the avoir' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a.amount_centimes), 0) INTO v_sum FROM public.allocation a WHERE a.payment_plan_item_id = v_item.id;
    IF v_sum + NEW.amount_centimes > v_item.amount_centimes THEN
      RAISE EXCEPTION 'allocation: more than the item' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Instrument first, then item, everywhere: no lock cycle.
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:' || NEW.instrument_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || v_target::text, 0));
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = NEW.instrument_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation: unknown instrument' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.payment_plan_item_id IS NOT NULL THEN
    SELECT * INTO v_item FROM public.payment_plan_item WHERE id = NEW.payment_plan_item_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'allocation: unknown item' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO v_pitem FROM public.purchase_plan_item WHERE id = NEW.purchase_plan_item_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'allocation: unknown item' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.allocation WHERE id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'allocation: unknown allocation to reverse' USING ERRCODE = 'check_violation';
    END IF;
    IF v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'allocation: a reversal cannot be reversed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.instrument_id <> v_orig.instrument_id
       OR NEW.payment_plan_item_id IS DISTINCT FROM v_orig.payment_plan_item_id
       OR NEW.purchase_plan_item_id IS DISTINCT FROM v_orig.purchase_plan_item_id
       OR NEW.invoice_id IS DISTINCT FROM v_orig.invoice_id
       OR NEW.amount_centimes <> -v_orig.amount_centimes THEN
      RAISE EXCEPTION 'allocation: a reversal negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.payment_plan_item_id IS NOT NULL THEN
    IF v_item.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = v_item.order_id) THEN
      RAISE EXCEPTION 'allocation: the item belongs to a cancelled order' USING ERRCODE = 'check_violation';
    END IF;
    IF v_item.direction <> v_i.direction THEN
      RAISE EXCEPTION 'allocation: the instrument and the item go in different directions' USING ERRCODE = 'check_violation';
    END IF;
    IF v_item.direction = 'in' AND v_i.client_id IS DISTINCT FROM (SELECT o.client_id FROM public.sales_order o WHERE o.id = v_item.order_id) THEN
      RAISE EXCEPTION 'allocation: the instrument belongs to another party' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF v_pitem.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.purchase r WHERE r.reverses_id = v_pitem.purchase_id) THEN
      RAISE EXCEPTION 'allocation: the item belongs to a cancelled purchase' USING ERRCODE = 'check_violation';
    END IF;
    IF v_i.direction <> 'out' THEN
      RAISE EXCEPTION 'allocation: the instrument and the item go in different directions' USING ERRCODE = 'check_violation';
    END IF;
    IF v_i.supplier_id IS DISTINCT FROM (SELECT p.supplier_id FROM public.purchase p WHERE p.id = v_pitem.purchase_id) THEN
      RAISE EXCEPTION 'allocation: the instrument belongs to another party' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Money directed at an invoice goes to a plan item of one of the orders that invoice bills, for the instrument's client.
  IF NEW.invoice_id IS NOT NULL THEN
    IF NEW.payment_plan_item_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.invoice i
          WHERE i.id = NEW.invoice_id AND i.credit_note_of IS NULL AND i.client_id = v_i.client_id
            AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id))
       OR NOT EXISTS (
         SELECT 1 FROM public.invoice_line l JOIN public.delivery d ON d.id = l.delivery_id
          WHERE l.invoice_id = NEW.invoice_id AND d.order_id = v_item.order_id) THEN
      RAISE EXCEPTION 'allocation: not an open invoice of this client and this order' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT e.event INTO v_state FROM public.instrument_event e WHERE e.instrument_id = v_i.id ORDER BY e.seq DESC LIMIT 1;
  IF v_state IN ('cancelled', 'bounced', 'disputed', 'regularized') THEN
    RAISE EXCEPTION 'allocation: the instrument can no longer cover anything' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(a.amount_centimes), 0) INTO v_sum FROM public.allocation a WHERE a.instrument_id = v_i.id;
  IF v_sum + NEW.amount_centimes > v_i.amount_centimes THEN
    RAISE EXCEPTION 'allocation: more than the instrument' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.payment_plan_item_id IS NOT NULL THEN
    SELECT coalesce(sum(a.amount_centimes), 0) INTO v_sum FROM public.allocation a WHERE a.payment_plan_item_id = v_item.id;
    IF v_sum + NEW.amount_centimes > v_item.amount_centimes THEN
      RAISE EXCEPTION 'allocation: more than the item' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT coalesce(sum(a.amount_centimes), 0) INTO v_sum FROM public.allocation a WHERE a.purchase_plan_item_id = v_pitem.id;
    IF v_sum + NEW.amount_centimes > v_pitem.amount_centimes THEN
      RAISE EXCEPTION 'allocation: more than the item' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Issues the avoir for a BL whose concrete was lost after it was billed: the owner only. Returns the AV number, or NULL when
-- there is nothing to credit (no loss record, not billed on a live invoice, already credited). The credit is applied on the plan
-- items of the BL's order, oldest due first, up to what is still open on each; any excess stays an unapplied credit of the avoir.
CREATE FUNCTION public.issue_avoir(p_delivery uuid, p_reason text, p_today date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role   text := ctx.role();
  v_user   uuid := ctx.user_id();
  v_loss   public.delivery_loss%ROWTYPE;
  v_order  uuid;
  v_inv    public.invoice%ROWTYPE;
  v_line   public.invoice_line%ROWTYPE;
  v_id     uuid := gen_random_uuid();
  v_ht     bigint;
  v_vat    bigint;
  v_number text;
  v_left   bigint;
  v_item   public.payment_plan_item%ROWTYPE;
  v_room   bigint;
  v_take   bigint;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'system') THEN
    RAISE EXCEPTION 'issue_avoir: role % may not issue an avoir', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 500 OR p_today IS NULL THEN
    RAISE EXCEPTION 'issue_avoir: a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('avoir:delivery:' || p_delivery::text, 0));
  SELECT l.* INTO v_loss FROM public.delivery_loss l WHERE l.delivery_id = p_delivery;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.avoir a WHERE a.loss_id = v_loss.id) THEN
    RETURN NULL;
  END IF;
  SELECT d.order_id INTO v_order FROM public.delivery d WHERE d.id = p_delivery AND d.reverses_id IS NULL;
  SELECT i.* INTO v_inv FROM public.invoice i JOIN public.invoice_line l ON l.invoice_id = i.id
   WHERE l.delivery_id = p_delivery AND i.credit_note_of IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id);
  IF v_order IS NULL OR v_inv.id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_line FROM public.invoice_line l WHERE l.invoice_id = v_inv.id AND l.delivery_id = p_delivery;
  v_ht := public.scale_qty(v_line.unit_price_ht_centimes, v_loss.volume_l, 1000);
  v_vat := public.scale_qty(v_ht, v_inv.vat_rate_bp, 10000);
  v_number := public.next_doc_number('AV', extract(year FROM p_today)::integer, 5);
  INSERT INTO public.avoir (id, number, invoice_id, delivery_id, loss_id, client_id, avoir_date, volume_l, unit_price_ht_centimes,
                            vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, reason, created_by)
  VALUES (v_id, v_number, v_inv.id, p_delivery, v_loss.id, v_inv.client_id, p_today, v_loss.volume_l,
          v_line.unit_price_ht_centimes, v_inv.vat_rate_bp, v_ht, v_vat, v_ht + v_vat, btrim(p_reason), v_user);
  v_left := v_ht + v_vat;
  FOR v_item IN
    SELECT * FROM public.payment_plan_item i WHERE i.order_id = v_order AND i.reverses_id IS NULL AND i.direction = 'in'
     ORDER BY i.due_date, i.seq
  LOOP
    EXIT WHEN v_left <= 0;
    PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || v_item.id::text, 0));
    SELECT v_item.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_room
      FROM public.allocation a WHERE a.payment_plan_item_id = v_item.id;
    CONTINUE WHEN v_room <= 0;
    v_take := least(v_room, v_left);
    INSERT INTO public.allocation (id, avoir_id, payment_plan_item_id, amount_centimes, invoice_id, created_by)
    VALUES (gen_random_uuid(), v_id, v_item.id, v_take, v_inv.id, v_user);
    v_left := v_left - v_take;
  END LOOP;
  RETURN v_number;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.issue_avoir(uuid, text, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.issue_avoir(uuid, text, date) TO belgobeton_app;
