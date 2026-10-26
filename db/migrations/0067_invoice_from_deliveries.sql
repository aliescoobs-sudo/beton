-- integration I1.4 (SPEC-integration AC-INT-06, 07, 08): an invoice is made from the selected BLs of ONE client, in one action,
-- across the client's orders. The stored lines stay one per load (the invoice guards, the credit note that mirrors them and the
-- "a load is invoiced once" rule keep working); the document groups them by product and price when it is shown. Advances the
-- client already paid on the orders are applied once, as a snapshot (`invoice_advance`), shown as "Acompte reçu" and "Net à
-- payer"; the invoice total itself never changes. Only delivered loads are invoiced. The invoice's payment state is derived
-- (D85) by one database function, per order, oldest due date first.

-- 1. An invoice may bill several orders: it no longer carries one. Rows written before keep theirs.
ALTER TABLE public.invoice ALTER COLUMN order_id DROP NOT NULL;
--> statement-breakpoint

-- 2. The advance applied on an invoice, per order. Insert-only, written only by create_invoice_from_deliveries.
CREATE TABLE public.invoice_advance (
  id              uuid PRIMARY KEY,
  invoice_id      uuid   NOT NULL REFERENCES public.invoice (id),
  order_id        uuid   NOT NULL REFERENCES public.sales_order (id),
  amount_centimes bigint NOT NULL CHECK (amount_centimes > 0),
  created_by      uuid   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, order_id)
);
--> statement-breakpoint
ALTER TABLE public.invoice_advance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.invoice_advance FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.invoice_advance FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.invoice_advance TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY invoice_advance_read ON public.invoice_advance FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY invoice_advance_definer_read ON public.invoice_advance FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY invoice_advance_definer_insert ON public.invoice_advance FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.invoice_advance');
--> statement-breakpoint
SELECT audit.attach('public.invoice_advance');
--> statement-breakpoint

-- The audit rows of the advance hold amounts: hidden from the roles that read no money.
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line', 'quote',
                     'alert', 'alert_event', 'cash_decision', 'fuel_purchase', 'invoice_advance')
$$;
--> statement-breakpoint

-- 3. The guards. An invoice with no order (several orders) is checked line by line; one that has an order (rows written
--    before, fixtures) is checked as before.
CREATE OR REPLACE FUNCTION public.invoice_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order public.sales_order%ROWTYPE;
  v_orig  public.invoice%ROWTYPE;
BEGIN
  IF NEW.credit_note_of IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.invoice i WHERE i.id = NEW.credit_note_of;
    IF NOT FOUND OR v_orig.credit_note_of IS NOT NULL THEN
      RAISE EXCEPTION 'invoice: a credit note credits an original invoice' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.order_id IS DISTINCT FROM v_orig.order_id OR NEW.client_id <> v_orig.client_id OR NEW.client_name <> v_orig.client_name
       OR NEW.client_ice IS DISTINCT FROM v_orig.client_ice OR NEW.vat_rate_bp <> v_orig.vat_rate_bp
       OR NEW.total_ht_centimes <> -v_orig.total_ht_centimes OR NEW.total_vat_centimes <> -v_orig.total_vat_centimes
       OR NEW.total_ttc_centimes <> -v_orig.total_ttc_centimes THEN
      RAISE EXCEPTION 'invoice: a credit note negates its invoice exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.order_id IS NOT NULL THEN
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
  END IF;
  IF NEW.total_vat_centimes <> public.scale_qty(NEW.total_ht_centimes, NEW.vat_rate_bp, 10000) THEN
    RAISE EXCEPTION 'invoice: VAT is not the rate on the total HT' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.invoice_line_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
  -- Only a delivered load is billed: delivered, and not wholly refused or brought back.
  IF NOT EXISTS (SELECT 1 FROM public.delivery_delivered g WHERE g.delivery_id = v_d.id)
     OR EXISTS (SELECT 1 FROM public.delivery_loss l WHERE l.delivery_id = v_d.id AND l.volume_l >= v_d.volume_l) THEN
    RAISE EXCEPTION 'invoice_line: the load is not delivered' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_o FROM public.sales_order o WHERE o.id = v_d.order_id;
  IF v_o.client_id <> v_i.client_id THEN
    RAISE EXCEPTION 'invoice_line: the load is not a load of the invoice''s client' USING ERRCODE = 'check_violation';
  END IF;
  IF v_i.order_id IS NOT NULL AND v_d.order_id <> v_i.order_id THEN
    RAISE EXCEPTION 'invoice_line: the load is not a load of the invoice''s order' USING ERRCODE = 'check_violation';
  END IF;
  IF v_o.vat_rate_bp <> v_i.vat_rate_bp THEN
    RAISE EXCEPTION 'invoice_line: not the VAT rate of the invoice' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.volume_l <> v_d.volume_l THEN
    RAISE EXCEPTION 'invoice_line: not the volume of the load' USING ERRCODE = 'check_violation';
  END IF;
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

-- The advance applied on an order never goes beyond what the client paid in advance, over all the live invoices.
CREATE FUNCTION public.invoice_advance_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_paid    bigint;
  v_applied bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice:advance:' || NEW.order_id::text, 0));
  SELECT coalesce(sum(a.amount_centimes), 0) INTO v_paid
    FROM public.payment_plan_item p JOIN public.allocation a ON a.payment_plan_item_id = p.id
   WHERE p.order_id = NEW.order_id AND p.method = 'advance';
  SELECT coalesce(sum(x.amount_centimes), 0) INTO v_applied
    FROM public.invoice_advance x JOIN public.invoice i ON i.id = x.invoice_id
   WHERE x.order_id = NEW.order_id AND x.id <> NEW.id
     AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id);
  IF v_applied + NEW.amount_centimes > v_paid THEN
    RAISE EXCEPTION 'invoice_advance: more than the advance received on the order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_advance_guard BEFORE INSERT ON public.invoice_advance
  FOR EACH ROW EXECUTE FUNCTION public.invoice_advance_guard();
--> statement-breakpoint

-- 4. The one door that makes an invoice from loads. Office and owner call it with BL ids and get the number back (or NULL);
--    nothing else leaves the database. Unknown, undelivered, already invoiced, of two clients or at two VAT rates: one
--    answer, audited, ten of them in ten minutes lock the actor out.
CREATE FUNCTION public.create_invoice_from_deliveries(p_delivery_ids uuid[], p_due date, p_today date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role    text := ctx.role();
  v_user    uuid := ctx.user_id();
  v_ids     uuid[];
  v_id      uuid := gen_random_uuid();
  v_fails   integer;
  v_due     date := coalesce(p_due, p_today + 60);
  v_n       integer;
  v_clients integer;
  v_rates   integer;
  v_client  public.client%ROWTYPE;
  v_rate    integer;
  v_first   date;
  v_ht      bigint;
  v_vat     bigint;
  v_total   bigint;
  v_number  text;
  v_seq     integer := 0;
  v_row     record;
  v_adv_left bigint;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'create_invoice_from_deliveries: role % may not create an invoice', coalesce(v_role, '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_today IS NULL OR v_due < p_today OR v_due > p_today + 120 THEN
    RAISE EXCEPTION 'create_invoice_from_deliveries: invalid due date' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_fails FROM public.audit_event e
   WHERE e.actor_user_id = v_user AND e.table_name = 'invoice_create' AND e.action = 'permission_denied'
     AND e.at > clock_timestamp() - interval '10 minutes';
  IF v_fails >= 10 THEN
    RAISE EXCEPTION 'create_invoice_from_deliveries: too many failed attempts, try again later'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(array_agg(x ORDER BY x), '{}') INTO v_ids FROM (SELECT DISTINCT unnest(p_delivery_ids) AS x) s;
  -- Two invoices racing for the same load take its lock in the same order, so they wait for each other.
  FOR v_row IN SELECT unnest(v_ids) AS id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('invoice:delivery:' || v_row.id::text, 0));
  END LOOP;

  SELECT count(*), count(DISTINCT o.client_id), count(DISTINCT o.vat_rate_bp), min(o.vat_rate_bp), min(d.load_date)
    INTO v_n, v_clients, v_rates, v_rate, v_first
    FROM public.delivery d
    JOIN public.sales_order o ON o.id = d.order_id
   WHERE d.id = ANY (v_ids) AND d.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
     AND EXISTS (SELECT 1 FROM public.delivery_delivered g WHERE g.delivery_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_loss l WHERE l.delivery_id = d.id AND l.volume_l >= d.volume_l)
     AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.invoice_line l JOIN public.invoice i ON i.id = l.invoice_id
        WHERE l.delivery_id = d.id AND i.credit_note_of IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.invoice cn WHERE cn.credit_note_of = i.id));
  IF cardinality(v_ids) = 0 OR v_n <> cardinality(v_ids) OR v_clients <> 1 OR v_rates <> 1 THEN
    PERFORM audit.record('permission_denied', 'invoice_create', 'deliveries:' || cardinality(v_ids), NULL, NULL,
                         'unknown or undelivered loads, already invoiced, of several clients or at several VAT rates');
    RETURN NULL;
  END IF;

  SELECT c.* INTO v_client FROM public.client c
   WHERE c.id = (SELECT o.client_id FROM public.delivery d JOIN public.sales_order o ON o.id = d.order_id WHERE d.id = v_ids[1]);
  SELECT coalesce(sum(public.scale_qty(o.unit_price_ht_centimes, d.volume_l, 1000)), 0) INTO v_ht
    FROM public.delivery d JOIN public.sales_order o ON o.id = d.order_id WHERE d.id = ANY (v_ids);
  v_vat := public.scale_qty(v_ht, v_rate, 10000);
  v_total := v_ht + v_vat;
  v_number := public.next_doc_number('FA', extract(year FROM p_today)::integer, 5);

  INSERT INTO public.invoice (id, number, order_id, client_id, client_name, client_ice, invoice_date, issue_deadline,
                              due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
  VALUES (v_id, v_number, NULL, v_client.id, v_client.name, v_client.ice, p_today,
          (date_trunc('month', v_first) + interval '1 month - 1 day')::date, v_due, v_rate,
          v_ht, v_vat, v_total, v_user);

  -- One stored line per load, grouped by product and price (the document groups them the same way).
  FOR v_row IN
    SELECT d.id, d.volume_l, d.bl_no, d.load_date, t.code AS type_code, o.unit_price_ht_centimes AS price
      FROM public.delivery d
      JOIN public.sales_order o ON o.id = d.order_id
      JOIN public.concrete_type t ON t.id = o.concrete_type_id
     WHERE d.id = ANY (v_ids)
     ORDER BY t.code, o.unit_price_ht_centimes, d.load_date, d.bl_no
  LOOP
    v_seq := v_seq + 1;
    INSERT INTO public.invoice_line (id, invoice_id, seq, delivery_id, description, volume_l, unit_price_ht_centimes,
                                     line_ht_centimes, created_by)
    VALUES (gen_random_uuid(), v_id, v_seq, v_row.id,
            'Béton ' || v_row.type_code || ' — BL ' || v_row.bl_no || ' du ' || to_char(v_row.load_date, 'YYYY-MM-DD'),
            v_row.volume_l, v_row.price, public.scale_qty(v_row.price, v_row.volume_l, 1000), v_user);
  END LOOP;

  -- Advances the client paid on these orders and no earlier invoice has used, up to what this invoice bills of each order.
  v_adv_left := v_total;
  FOR v_row IN
    SELECT o.id AS order_id,
           (sum(public.scale_qty(o.unit_price_ht_centimes, d.volume_l, 1000))::bigint
            + public.scale_qty(sum(public.scale_qty(o.unit_price_ht_centimes, d.volume_l, 1000))::bigint, v_rate, 10000)) AS portion
      FROM public.delivery d JOIN public.sales_order o ON o.id = d.order_id
     WHERE d.id = ANY (v_ids) GROUP BY o.id ORDER BY o.id
  LOOP
    DECLARE
      v_paid    bigint;
      v_applied bigint;
      v_take    bigint;
    BEGIN
      SELECT coalesce(sum(a.amount_centimes), 0) INTO v_paid
        FROM public.payment_plan_item p JOIN public.allocation a ON a.payment_plan_item_id = p.id
       WHERE p.order_id = v_row.order_id AND p.method = 'advance';
      SELECT coalesce(sum(x.amount_centimes), 0) INTO v_applied
        FROM public.invoice_advance x JOIN public.invoice i ON i.id = x.invoice_id
       WHERE x.order_id = v_row.order_id AND i.id <> v_id
         AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id);
      v_take := least(greatest(v_paid - v_applied, 0), v_row.portion, v_adv_left);
      IF v_take > 0 THEN
        INSERT INTO public.invoice_advance (id, invoice_id, order_id, amount_centimes, created_by)
        VALUES (gen_random_uuid(), v_id, v_row.order_id, v_take, v_user);
        v_adv_left := v_adv_left - v_take;
      END IF;
    END;
  END LOOP;
  RETURN v_number;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_invoice_from_deliveries(uuid[], date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_invoice_from_deliveries(uuid[], date, date) TO belgobeton_app;
--> statement-breakpoint

-- The order-code door keeps its shape: the order's delivered loads no live invoice carries (or the ones named), made into one
-- invoice by the function above.
CREATE OR REPLACE FUNCTION public.create_invoice(p_order_code text, p_delivery_ids uuid[], p_due date, p_today date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text := ctx.role();
  v_user  uuid := ctx.user_id();
  v_order public.sales_order%ROWTYPE;
  v_loads uuid[];
  v_n     integer;
  v_fails integer;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'create_invoice: role % may not create an invoice', coalesce(v_role, '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO v_fails FROM public.audit_event e
   WHERE e.actor_user_id = v_user AND e.table_name = 'invoice_create' AND e.action = 'permission_denied'
     AND e.at > clock_timestamp() - interval '10 minutes';
  IF v_fails >= 10 THEN
    RAISE EXCEPTION 'create_invoice: too many failed attempts, try again later' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT o.* INTO v_order FROM public.sales_order o
   WHERE o.code = p_order_code AND o.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id);
  IF FOUND THEN
    SELECT array_agg(d.id ORDER BY d.load_date, d.bl_no) INTO v_loads
      FROM public.delivery d
     WHERE d.order_id = v_order.id AND d.reverses_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
       AND EXISTS (SELECT 1 FROM public.delivery_delivered g WHERE g.delivery_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.delivery_loss l WHERE l.delivery_id = d.id AND l.volume_l >= d.volume_l)
       AND NOT EXISTS (
         SELECT 1 FROM public.invoice_line l JOIN public.invoice i ON i.id = l.invoice_id
          WHERE l.delivery_id = d.id AND i.credit_note_of IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.invoice cn WHERE cn.credit_note_of = i.id))
       AND (p_delivery_ids IS NULL OR d.id = ANY (p_delivery_ids));
    v_n := coalesce(cardinality(v_loads), 0);
    IF p_delivery_ids IS NOT NULL AND v_n <> cardinality(ARRAY(SELECT DISTINCT unnest(p_delivery_ids))) THEN
      v_n := 0;
    END IF;
  ELSE
    v_n := 0;
  END IF;
  IF v_n = 0 THEN
    PERFORM audit.record('permission_denied', 'invoice_create', left(p_order_code, 40), NULL, NULL,
                         'unknown order, nothing to invoice or loads that do not match');
    RETURN NULL;
  END IF;
  RETURN public.create_invoice_from_deliveries(v_loads, p_due, p_today);
END $$;
--> statement-breakpoint

-- 5. The payment state of the live invoices, derived (D85, extended to invoices that bill several orders): what the client paid
--    on each order covers the invoices that bill it, oldest due date first (then invoice date, number); an invoice's share of
--    an order is its lines of that order with VAT, the rounding settled so that the shares add up to its total. Owner and
--    support only (money). Never stored.
CREATE FUNCTION public.invoice_payment_state() RETURNS TABLE (invoice_id uuid, total_ttc_centimes bigint, paid_centimes bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'support', 'system') THEN
    RAISE EXCEPTION 'invoice_payment_state: role % may not read payment states', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  WITH live AS (
    SELECT i.* FROM public.invoice i
     WHERE i.credit_note_of IS NULL AND NOT EXISTS (SELECT 1 FROM public.invoice c WHERE c.credit_note_of = i.id)
  ), per_order AS (
    SELECT l.invoice_id AS inv, d.order_id AS ord, sum(l.line_ht_centimes)::bigint AS ht
      FROM public.invoice_line l JOIN live v ON v.id = l.invoice_id JOIN public.delivery d ON d.id = l.delivery_id
     GROUP BY l.invoice_id, d.order_id
  ), cumulative AS (
    SELECT p.inv, p.ord, sum(p.ht) OVER (PARTITION BY p.inv ORDER BY p.ord)::bigint AS cum_ht FROM per_order p
  ), shares AS (
    SELECT c.inv, c.ord,
           ((c.cum_ht + public.scale_qty(c.cum_ht, v.vat_rate_bp, 10000))
            - coalesce(lag(c.cum_ht + public.scale_qty(c.cum_ht, v.vat_rate_bp, 10000)) OVER (PARTITION BY c.inv ORDER BY c.ord), 0))::bigint AS ttc,
           v.due_date, v.invoice_date, v.number
      FROM cumulative c JOIN live v ON v.id = c.inv
  ), covered AS (
    SELECT s.ord, coalesce(sum(a.amount_centimes), 0)::bigint AS cov
      FROM (SELECT DISTINCT shares.ord FROM shares) s
      LEFT JOIN public.payment_plan_item pi ON pi.order_id = s.ord
      LEFT JOIN public.allocation a ON a.payment_plan_item_id = pi.id
     GROUP BY s.ord
  ), fifo AS (
    SELECT sh.inv,
           least(sh.ttc, greatest(0, cv.cov - coalesce(sum(sh.ttc) OVER (
             PARTITION BY sh.ord ORDER BY sh.due_date, sh.invoice_date, sh.number, sh.inv
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)))::bigint AS paid
      FROM shares sh JOIN covered cv ON cv.ord = sh.ord
  )
  SELECT v.id, v.total_ttc_centimes, coalesce(sum(f.paid), 0)::bigint
    FROM live v LEFT JOIN fifo f ON f.inv = v.id
   GROUP BY v.id, v.total_ttc_centimes;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.invoice_payment_state() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.invoice_payment_state() TO belgobeton_app;
