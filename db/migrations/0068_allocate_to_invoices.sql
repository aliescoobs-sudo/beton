-- integration I1.5 (SPEC-integration AC-INT-09, 10, 11): a payment is spread over ALL the open invoices of the client, oldest
-- due date first, as allocation records. The money stays on the plan items of the orders (D85: the plan is the source of truth),
-- and each allocation row carries the invoice it was made for (`invoice_id`), so the state of an invoice is its own tagged money
-- plus its share of what was paid on the order untagged. The owner may direct money to a given invoice, with a reason, audited
-- with the row. A bounce reverses its allocations (the tag goes with the reversal), which reopens the invoices.

-- 1. The tag, and the reason of an override.
ALTER TABLE public.allocation ADD COLUMN invoice_id uuid REFERENCES public.invoice (id);
--> statement-breakpoint
ALTER TABLE public.allocation ADD COLUMN override_reason text
  CHECK (override_reason = btrim(override_reason) AND length(override_reason) BETWEEN 3 AND 500);
--> statement-breakpoint
ALTER TABLE public.allocation ADD CONSTRAINT allocation_tag_on_plan_items
  CHECK (invoice_id IS NULL OR payment_plan_item_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE public.allocation ADD CONSTRAINT allocation_override_needs_invoice
  CHECK (override_reason IS NULL OR (invoice_id IS NOT NULL AND reverses_id IS NULL));
--> statement-breakpoint
CREATE INDEX allocation_invoice_idx ON public.allocation (invoice_id) WHERE invoice_id IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.allocation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i      public.payment_instrument%ROWTYPE;
  v_item   public.payment_plan_item%ROWTYPE;
  v_pitem  public.purchase_plan_item%ROWTYPE;
  v_orig   public.allocation%ROWTYPE;
  v_state  text;
  v_sum    bigint;
  v_target uuid := coalesce(NEW.payment_plan_item_id, NEW.purchase_plan_item_id);
BEGIN
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

-- 2. The shares of the live invoices, derived: for each invoice and each order it bills, its share (the lines of that order with
--    VAT, the rounding settled so the shares add up to the invoice total) and what is paid of it: the money tagged for that
--    invoice, then what was paid on the order untagged, oldest due date first (then invoice date, number). Internal: the
--    application role cannot execute it; the public functions below check the role.
CREATE FUNCTION public._invoice_shares()
RETURNS TABLE (inv_id uuid, ord_id uuid, cli_id uuid, due date, inv_date date, inv_number text, share bigint, paid bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH live AS (
    SELECT i.id, i.client_id, i.due_date, i.invoice_date, i.number, i.vat_rate_bp FROM public.invoice i
     WHERE i.credit_note_of IS NULL AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id)
  ), per_order AS (
    SELECT l.invoice_id AS inv, d.order_id AS ord, sum(l.line_ht_centimes)::bigint AS ht
      FROM public.invoice_line l JOIN live v ON v.id = l.invoice_id JOIN public.delivery d ON d.id = l.delivery_id
     GROUP BY l.invoice_id, d.order_id
  ), cumulative AS (
    SELECT p.inv, p.ord, sum(p.ht) OVER (PARTITION BY p.inv ORDER BY p.ord)::bigint AS cum_ht FROM per_order p
  ), shares AS (
    SELECT c.inv, c.ord, v.client_id AS cli, v.due_date AS due, v.invoice_date AS idate, v.number AS num,
           ((c.cum_ht + public.scale_qty(c.cum_ht, v.vat_rate_bp, 10000))
            - coalesce(lag(c.cum_ht + public.scale_qty(c.cum_ht, v.vat_rate_bp, 10000)) OVER (PARTITION BY c.inv ORDER BY c.ord), 0))::bigint AS ttc
      FROM cumulative c JOIN live v ON v.id = c.inv
  ), tagged AS (
    SELECT a.invoice_id AS inv, pi.order_id AS ord, sum(a.amount_centimes)::bigint AS t
      FROM public.allocation a JOIN public.payment_plan_item pi ON pi.id = a.payment_plan_item_id
     WHERE a.invoice_id IS NOT NULL
     GROUP BY a.invoice_id, pi.order_id
  ), s1 AS (
    SELECT sh.*, least(sh.ttc, greatest(0, coalesce(t.t, 0)))::bigint AS tg
      FROM shares sh LEFT JOIN tagged t ON t.inv = sh.inv AND t.ord = sh.ord
  ), covered AS (
    SELECT s.ord, coalesce(sum(a.amount_centimes), 0)::bigint AS cov
      FROM (SELECT DISTINCT s1.ord FROM s1) s
      LEFT JOIN public.payment_plan_item pi ON pi.order_id = s.ord
      LEFT JOIN public.allocation a ON a.payment_plan_item_id = pi.id
     GROUP BY s.ord
  ), free AS (
    SELECT c.ord, greatest(0, c.cov - coalesce((SELECT sum(x.tg) FROM s1 x WHERE x.ord = c.ord), 0))::bigint AS f FROM covered c
  ), fifo AS (
    SELECT s1.inv, s1.ord, s1.cli, s1.due, s1.idate, s1.num, s1.ttc, s1.tg,
           least(s1.ttc - s1.tg, greatest(0, f.f - coalesce(sum(s1.ttc - s1.tg) OVER (
             PARTITION BY s1.ord ORDER BY s1.due, s1.idate, s1.num, s1.inv
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)))::bigint AS fill
      FROM s1 JOIN free f ON f.ord = s1.ord
  )
  SELECT fifo.inv, fifo.ord, fifo.cli, fifo.due, fifo.idate, fifo.num, fifo.ttc, (fifo.tg + fifo.fill)::bigint FROM fifo
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._invoice_shares() FROM PUBLIC;
--> statement-breakpoint

-- 3. The payment state of the live invoices (owner and support), now from the shares above.
CREATE OR REPLACE FUNCTION public.invoice_payment_state() RETURNS TABLE (invoice_id uuid, total_ttc_centimes bigint, paid_centimes bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'support', 'system') THEN
    RAISE EXCEPTION 'invoice_payment_state: role % may not read payment states', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT i.id, i.total_ttc_centimes, coalesce(sum(s.paid), 0)::bigint
    FROM public.invoice i LEFT JOIN public._invoice_shares() s ON s.inv_id = i.id
   WHERE i.credit_note_of IS NULL AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id)
   GROUP BY i.id, i.total_ttc_centimes;
END $$;
--> statement-breakpoint

-- 4. A payment of a client with no order named: the open invoices, oldest due date first, each through the plan items of the
--    orders it bills; then, what is left, the client's other open plan items (an advance of an order not invoiced yet),
--    oldest first; the rest stays unallocated. Office enters it blind: the function returns a count and nothing else.
CREATE FUNCTION public.allocate_to_client(p_instrument uuid, p_client_code text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text := ctx.role();
  v_i     public.payment_instrument%ROWTYPE;
  v_left  bigint;
  v_open  bigint;
  v_take  bigint;
  v_n     integer := 0;
  v_share record;
  v_item  public.payment_plan_item%ROWTYPE;
  v_room  bigint;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'allocate_to_client: role % may not allocate', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = p_instrument;
  IF NOT FOUND OR v_i.direction <> 'in' OR (v_role = 'office' AND v_i.created_by <> ctx.user_id())
     OR NOT EXISTS (SELECT 1 FROM public.client c WHERE c.code = p_client_code AND c.id = v_i.client_id) THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:' || v_i.id::text, 0));
  SELECT v_i.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_left
    FROM public.allocation a WHERE a.instrument_id = v_i.id;
  FOR v_share IN
    SELECT s.* FROM public._invoice_shares() s WHERE s.cli_id = v_i.client_id AND s.share > s.paid
     ORDER BY s.due, s.inv_date, s.inv_number, s.ord_id
  LOOP
    EXIT WHEN v_left <= 0;
    v_open := v_share.share - v_share.paid;
    FOR v_item IN
      SELECT * FROM public.payment_plan_item i WHERE i.order_id = v_share.ord_id AND i.reverses_id IS NULL ORDER BY i.due_date, i.seq
    LOOP
      EXIT WHEN v_left <= 0 OR v_open <= 0;
      PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || v_item.id::text, 0));
      SELECT v_item.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_room
        FROM public.allocation a WHERE a.payment_plan_item_id = v_item.id;
      CONTINUE WHEN v_room <= 0;
      v_take := least(v_room, v_left, v_open);
      INSERT INTO public.allocation (id, instrument_id, payment_plan_item_id, amount_centimes, invoice_id, created_by)
      VALUES (gen_random_uuid(), v_i.id, v_item.id, v_take, v_share.inv_id, ctx.user_id());
      v_left := v_left - v_take;
      v_open := v_open - v_take;
      v_n := v_n + 1;
    END LOOP;
  END LOOP;
  FOR v_item IN
    SELECT i.* FROM public.payment_plan_item i JOIN public.sales_order o ON o.id = i.order_id
     WHERE o.client_id = v_i.client_id AND o.reverses_id IS NULL AND i.reverses_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
     ORDER BY i.due_date, i.seq
  LOOP
    EXIT WHEN v_left <= 0;
    PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || v_item.id::text, 0));
    SELECT v_item.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_room
      FROM public.allocation a WHERE a.payment_plan_item_id = v_item.id;
    CONTINUE WHEN v_room <= 0;
    v_take := least(v_room, v_left);
    INSERT INTO public.allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by)
    VALUES (gen_random_uuid(), v_i.id, v_item.id, v_take, ctx.user_id());
    v_left := v_left - v_take;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.allocate_to_client(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.allocate_to_client(uuid, text) TO belgobeton_app;
--> statement-breakpoint

-- 5. The owner directs (part of) a payment to one invoice, with a reason: its open amount through the plan items of the orders
--    it bills, the rows tagged with the invoice and the reason (the audit trail of the override). Returns what was allocated.
CREATE FUNCTION public.allocate_to_invoice(p_instrument uuid, p_invoice uuid, p_amount bigint, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text := ctx.role();
  v_i     public.payment_instrument%ROWTYPE;
  v_left  bigint;
  v_want  bigint := p_amount;
  v_total bigint := 0;
  v_take  bigint;
  v_room  bigint;
  v_open  bigint;
  v_share record;
  v_item  public.payment_plan_item%ROWTYPE;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'system') THEN
    RAISE EXCEPTION 'allocate_to_invoice: role % may not direct a payment', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 500 OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'allocate_to_invoice: a reason and an amount are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = p_instrument;
  IF NOT FOUND OR v_i.direction <> 'in' THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:' || v_i.id::text, 0));
  SELECT v_i.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_left
    FROM public.allocation a WHERE a.instrument_id = v_i.id;
  v_want := least(v_want, v_left);
  FOR v_share IN
    SELECT s.* FROM public._invoice_shares() s
     WHERE s.inv_id = p_invoice AND s.cli_id = v_i.client_id AND s.share > s.paid ORDER BY s.ord_id
  LOOP
    EXIT WHEN v_want <= 0;
    v_open := v_share.share - v_share.paid;
    FOR v_item IN
      SELECT * FROM public.payment_plan_item i WHERE i.order_id = v_share.ord_id AND i.reverses_id IS NULL ORDER BY i.due_date, i.seq
    LOOP
      EXIT WHEN v_want <= 0 OR v_open <= 0;
      PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || v_item.id::text, 0));
      SELECT v_item.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_room
        FROM public.allocation a WHERE a.payment_plan_item_id = v_item.id;
      CONTINUE WHEN v_room <= 0;
      v_take := least(v_room, v_want, v_open);
      INSERT INTO public.allocation (id, instrument_id, payment_plan_item_id, amount_centimes, invoice_id, override_reason, created_by)
      VALUES (gen_random_uuid(), v_i.id, v_item.id, v_take, p_invoice, btrim(p_reason), ctx.user_id());
      v_want := v_want - v_take;
      v_open := v_open - v_take;
      v_total := v_total + v_take;
    END LOOP;
  END LOOP;
  RETURN v_total;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.allocate_to_invoice(uuid, uuid, bigint, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.allocate_to_invoice(uuid, uuid, bigint, text) TO belgobeton_app;
