-- Review of CP-L4 (HIGH): an office-context call must never receive a price, a total, a client or a load. The old doors
-- returned them (invoice_source: client, unit price and loads of any order code; resolve_selling_price: the price of any type
-- for any client) and order codes are sequential, so office could enumerate every client's prices through the server. The
-- guard triggers were a second door: office could INSERT a crafted row and read the "not the price in force" error as a yes/no.
--
-- Now:
--   * create_invoice / create_order / create_quote build the document ENTIRELY inside the database from the order code (or the
--     ids) and return only the document number, or NULL / a generic error. Nothing else leaves the database.
--   * create_invoice audits every call that fails and refuses an actor after 10 failed attempts in 10 minutes.
--   * office has no INSERT policy on sales_order, payment_plan_item, quote, invoice or invoice_line any more: the functions are
--     the only way in, so a guard error can no longer be used as an oracle.
--   * resolve_selling_price answers the owner and the system only; the guards use an internal lookup the application role
--     cannot execute. invoice_source is dropped.
-- The owner keeps writing through the services (price override, credit notes); the same triggers check every row.

-- 1. The internal price lookup (no role check, not executable by the application role) and the public one, owner only.
CREATE FUNCTION public._price_in_force(p_type uuid, p_client uuid, p_date date)
RETURNS TABLE (id uuid, price_ht_per_m3_centimes bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT sp.id, sp.price_ht_per_m3_centimes FROM public.selling_price sp
   WHERE sp.concrete_type_id = p_type AND sp.effective_from <= p_date AND (sp.client_id = p_client OR sp.client_id IS NULL)
   ORDER BY (sp.client_id IS NOT NULL) DESC, sp.effective_from DESC
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._price_in_force(uuid, uuid, date) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.resolve_selling_price(p_type uuid, p_client uuid, p_date date)
RETURNS TABLE (id uuid, price_ht_per_m3_centimes bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'system') THEN
    RAISE EXCEPTION 'resolve_selling_price: role % may not resolve a price', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM public._price_in_force(p_type, p_client, p_date);
END $$;
--> statement-breakpoint

-- 2. The guards look the price up through the internal function (their own session role is office when office creates a document).
CREATE OR REPLACE FUNCTION public.sales_order_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_price  record;
  v_res    record;
  v_orig   public.sales_order%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.sales_order o WHERE o.id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sales_order: unknown order to reverse' USING ERRCODE = 'check_violation';
    END IF;
    IF v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'sales_order: a reversal cannot be reversed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.client_id <> v_orig.client_id OR NEW.concrete_type_id <> v_orig.concrete_type_id
       OR NEW.site_id IS DISTINCT FROM v_orig.site_id OR NEW.zone_id IS DISTINCT FROM v_orig.zone_id
       OR NEW.order_date <> v_orig.order_date OR NEW.delivery_date <> v_orig.delivery_date
       OR NEW.selling_price_id <> v_orig.selling_price_id OR NEW.unit_price_ht_centimes <> v_orig.unit_price_ht_centimes
       OR NEW.vat_rate_bp <> v_orig.vat_rate_bp OR NEW.volume_l <> -v_orig.volume_l
       OR NEW.total_ht_centimes <> -v_orig.total_ht_centimes OR NEW.total_vat_centimes <> -v_orig.total_vat_centimes
       OR NEW.total_ttc_centimes <> -v_orig.total_ttc_centimes THEN
      RAISE EXCEPTION 'sales_order: a reversal negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT c.status INTO v_status FROM public.client c WHERE c.id = NEW.client_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'sales_order: the client is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_site s WHERE s.id = NEW.site_id AND s.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION 'sales_order: the site does not belong to the client' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.status INTO v_status FROM public.concrete_type t WHERE t.id = NEW.concrete_type_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'sales_order: the concrete type is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.brought_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."user" u WHERE u.id = NEW.brought_by_user_id::text AND u.role IN ('owner', 'partner')
  ) THEN
    RAISE EXCEPTION 'sales_order: brought_by must be the owner or the partner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.quote_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_price  record;
  v_res    record;
BEGIN
  SELECT c.status INTO v_status FROM public.client c WHERE c.id = NEW.client_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'quote: the client is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.status INTO v_status FROM public.concrete_type t WHERE t.id = NEW.concrete_type_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'quote: the concrete type is not active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint


-- The price checks run AFTER the row passes row-level security: a BEFORE trigger fires before the policy is evaluated, so an
-- error raised there ("the price is not the one in force") would be readable by office even though its insert is refused,
-- a yes/no oracle on a price. An AFTER trigger is reached only by a row the caller is allowed to write.
CREATE FUNCTION public.sales_order_price_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_price record;
  v_res   record;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT sp.concrete_type_id, sp.price_ht_per_m3_centimes AS price INTO v_price
    FROM public.selling_price sp WHERE sp.id = NEW.selling_price_id;
  IF NOT FOUND OR v_price.concrete_type_id <> NEW.concrete_type_id THEN
    RAISE EXCEPTION 'sales_order: unknown price for this concrete type' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reason IS NULL THEN
    SELECT r.id, r.price_ht_per_m3_centimes AS price INTO v_res
      FROM public._price_in_force(NEW.concrete_type_id, NEW.client_id, NEW.order_date) r;
    IF v_res.id IS DISTINCT FROM NEW.selling_price_id OR v_price.price <> NEW.unit_price_ht_centimes THEN
      RAISE EXCEPTION 'sales_order: the price is not the one in force' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_order_price_guard AFTER INSERT ON public.sales_order
  FOR EACH ROW EXECUTE FUNCTION public.sales_order_price_guard();
--> statement-breakpoint
CREATE FUNCTION public.quote_price_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_price record;
  v_res   record;
BEGIN
  SELECT sp.concrete_type_id, sp.price_ht_per_m3_centimes AS price INTO v_price
    FROM public.selling_price sp WHERE sp.id = NEW.selling_price_id;
  IF NOT FOUND OR v_price.concrete_type_id <> NEW.concrete_type_id THEN
    RAISE EXCEPTION 'quote: unknown price for this concrete type' USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.id, r.price_ht_per_m3_centimes AS price INTO v_res
    FROM public._price_in_force(NEW.concrete_type_id, NEW.client_id, NEW.quote_date) r;
  IF v_res.id IS DISTINCT FROM NEW.selling_price_id OR v_price.price <> NEW.unit_price_ht_centimes THEN
    RAISE EXCEPTION 'quote: the price is not the one in force' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER quote_price_guard AFTER INSERT ON public.quote
  FOR EACH ROW EXECUTE FUNCTION public.quote_price_guard();
--> statement-breakpoint
-- invoice_line: the unit price and the line total are checked after the policy too.
CREATE OR REPLACE FUNCTION public.invoice_line_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i    public.invoice%ROWTYPE;
  v_d    public.delivery%ROWTYPE;
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
CREATE FUNCTION public.invoice_line_price_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i public.invoice%ROWTYPE;
  v_o public.sales_order%ROWTYPE;
BEGIN
  SELECT * INTO v_i FROM public.invoice i WHERE i.id = NEW.invoice_id;
  IF v_i.credit_note_of IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_o FROM public.sales_order o WHERE o.id = v_i.order_id;
  IF NEW.unit_price_ht_centimes <> v_o.unit_price_ht_centimes THEN
    RAISE EXCEPTION 'invoice_line: not the unit price of the order' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.line_ht_centimes <> public.scale_qty(NEW.unit_price_ht_centimes, NEW.volume_l, 1000) THEN
    RAISE EXCEPTION 'invoice_line: the line total is not volume times price' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_line_price_guard AFTER INSERT ON public.invoice_line
  FOR EACH ROW EXECUTE FUNCTION public.invoice_line_price_guard();
--> statement-breakpoint

-- 3. Office may no longer insert into the tables the functions write: the definer functions (run as the migrator) get the policies.
DROP POLICY sales_order_insert ON public.sales_order;
--> statement-breakpoint
CREATE POLICY sales_order_insert ON public.sales_order FOR INSERT TO belgobeton_app
  WITH CHECK (
    created_by = ctx.user_id() AND ctx.role() = 'owner'
  );
--> statement-breakpoint
DROP POLICY payment_plan_item_insert ON public.payment_plan_item;
--> statement-breakpoint
CREATE POLICY payment_plan_item_insert ON public.payment_plan_item FOR INSERT TO belgobeton_app
  WITH CHECK (created_by = ctx.user_id() AND direction = 'in' AND ctx.role() = 'owner');
--> statement-breakpoint
DROP POLICY quote_insert ON public.quote;
--> statement-breakpoint
CREATE POLICY quote_insert ON public.quote FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
DROP POLICY invoice_insert ON public.invoice;
--> statement-breakpoint
CREATE POLICY invoice_insert ON public.invoice FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
DROP POLICY invoice_line_insert ON public.invoice_line;
--> statement-breakpoint
CREATE POLICY invoice_line_insert ON public.invoice_line FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY sales_order_definer_insert ON public.sales_order FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY payment_plan_item_definer_insert ON public.payment_plan_item FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY quote_definer_insert ON public.quote FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY invoice_definer_insert ON public.invoice FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY invoice_line_definer_insert ON public.invoice_line FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

-- 4. create_invoice: from the order code, entirely inside the database. Returns the invoice number; NULL for an unknown order,
--    nothing left to invoice or loads that do not match (one answer for all three, so the code space cannot be probed); every
--    NULL is audited and ten of them in ten minutes lock the actor out of the function.
CREATE FUNCTION public.create_invoice(p_order_code text, p_delivery_ids uuid[], p_due date, p_today date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role    text := ctx.role();
  v_user    uuid := ctx.user_id();
  v_order   public.sales_order%ROWTYPE;
  v_client  public.client%ROWTYPE;
  v_loads   uuid[];
  v_n       integer;
  v_fails   integer;
  v_due     date := coalesce(p_due, p_today + 60);
  v_last    date;
  v_ht      bigint;
  v_vat     bigint;
  v_id      uuid := gen_random_uuid();
  v_number  text;
  v_seq     integer := 0;
  v_row     record;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'create_invoice: role % may not create an invoice', coalesce(v_role, '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_today IS NULL OR v_due < p_today OR v_due > p_today + 120 THEN
    RAISE EXCEPTION 'create_invoice: invalid due date' USING ERRCODE = 'check_violation';
  END IF;
  -- Rate limit: failures of this actor in the audit log.
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

  SELECT * INTO v_client FROM public.client c WHERE c.id = v_order.client_id;
  SELECT coalesce(sum(public.scale_qty(v_order.unit_price_ht_centimes, d.volume_l, 1000)), 0), max(d.load_date)
    INTO v_ht, v_last
    FROM public.delivery d WHERE d.id = ANY (v_loads);
  v_vat := public.scale_qty(v_ht, v_order.vat_rate_bp, 10000);
  v_number := public.next_doc_number('FA', extract(year FROM p_today)::integer, 5);

  INSERT INTO public.invoice (id, number, order_id, client_id, client_name, client_ice, invoice_date, issue_deadline,
                              due_date, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
  VALUES (v_id, v_number, v_order.id, v_order.client_id, v_client.name, v_client.ice, p_today,
          (date_trunc('month', v_last) + interval '1 month - 1 day')::date, v_due, v_order.vat_rate_bp,
          v_ht, v_vat, v_ht + v_vat, v_user);
  FOR v_row IN
    SELECT d.id, d.volume_l, d.bl_no, d.load_date, t.code AS type_code
      FROM public.delivery d JOIN public.concrete_type t ON t.id = v_order.concrete_type_id
     WHERE d.id = ANY (v_loads) ORDER BY d.load_date, d.bl_no
  LOOP
    v_seq := v_seq + 1;
    INSERT INTO public.invoice_line (id, invoice_id, seq, delivery_id, description, volume_l, unit_price_ht_centimes,
                                     line_ht_centimes, created_by)
    VALUES (gen_random_uuid(), v_id, v_seq, v_row.id,
            'Béton ' || v_row.type_code || ' — BL ' || v_row.bl_no || ' du ' || to_char(v_row.load_date, 'YYYY-MM-DD'),
            v_row.volume_l, v_order.unit_price_ht_centimes,
            public.scale_qty(v_order.unit_price_ht_centimes, v_row.volume_l, 1000), v_user);
  END LOOP;
  RETURN v_number;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_invoice(text, uuid[], date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_invoice(text, uuid[], date, date) TO belgobeton_app;
--> statement-breakpoint
DROP FUNCTION public.invoice_source(text);
--> statement-breakpoint

-- 5. create_order and create_quote: the price is resolved, the totals and the payment plan computed and the rows written inside
--    the database; only the document code comes back. The rounding is the domain's (scale_qty = mulDivRound, half away from
--    zero, one rounding per figure); a property test compares them with the TypeScript functions.
CREATE FUNCTION public.create_order(
  p_client uuid, p_site uuid, p_zone uuid, p_type uuid, p_volume_l integer, p_delivery date, p_today date,
  p_brought_by uuid, p_quote uuid, p_plan jsonb, p_vat_default integer
) RETURNS TABLE (code text, id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role   text := ctx.role();
  v_user   uuid := ctx.user_id();
  v_client public.client%ROWTYPE;
  v_zone   uuid;
  v_price  record;
  v_vat    integer;
  v_ht     bigint;
  v_vatamt bigint;
  v_ttc    bigint;
  v_id     uuid := gen_random_uuid();
  v_code   text;
  v_preset text := p_plan ->> 'preset';
  v_items  jsonb;
  v_item   jsonb;
  v_n      integer;
  v_i      integer;
  v_method text;
  v_due    date;
  v_bp     integer;
  v_amt    bigint;
  v_allocated bigint := 0;
  v_bp_sum integer := 0;
  v_amt_sum bigint := 0;
  v_percent integer := 0;
  v_fixed  integer := 0;
  v_methods text[] := '{}';
  v_dues   date[] := '{}';
  v_amounts bigint[] := '{}';
  v_bps    integer[] := '{}';
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office') THEN
    RAISE EXCEPTION 'create_order: role % may not create an order', coalesce(v_role, '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_volume_l IS NULL OR p_volume_l < 1 OR p_volume_l > 100000000 OR p_today IS NULL OR p_delivery IS NULL OR p_delivery < p_today THEN
    RAISE EXCEPTION 'create_order: invalid volume or dates' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_client FROM public.client c WHERE c.id = p_client;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_order: unknown client' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.concrete_type t WHERE t.id = p_type) THEN
    RAISE EXCEPTION 'create_order: unknown concrete type' USING ERRCODE = 'foreign_key_violation';
  END IF;
  v_zone := coalesce(p_zone, (SELECT s.zone_id FROM public.client_site s WHERE s.id = p_site), v_client.default_zone_id);
  SELECT * INTO v_price FROM public._price_in_force(p_type, p_client, p_today);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_order: the price is not the one in force' USING ERRCODE = 'check_violation';
  END IF;
  SELECT (p.value #>> '{}')::integer INTO v_vat FROM public.parameter p WHERE p.key = 'vat_rate_bp';
  v_vat := coalesce(v_vat, p_vat_default);
  IF v_vat IS NULL OR v_vat < 0 OR v_vat > 10000 THEN
    RAISE EXCEPTION 'create_order: invalid VAT rate' USING ERRCODE = 'check_violation';
  END IF;
  v_ht := public.scale_qty(v_price.price_ht_per_m3_centimes, p_volume_l, 1000);
  v_vatamt := public.scale_qty(v_ht, v_vat, 10000);
  v_ttc := v_ht + v_vatamt;

  -- The plan: a preset (shares in basis points, the last item absorbs the rounding) or custom items.
  IF v_preset = 'cash' THEN
    v_items := jsonb_build_array(jsonb_build_object('method', 'cash', 'dueDate', p_delivery, 'percentBp', 10000));
  ELSIF v_preset = 'advance50' THEN
    v_items := jsonb_build_array(
      jsonb_build_object('method', 'advance', 'dueDate', p_today, 'percentBp', 5000),
      jsonb_build_object('method', 'cash', 'dueDate', p_delivery, 'percentBp', 5000));
  ELSIF v_preset = 'installments3' THEN
    v_items := jsonb_build_array(
      jsonb_build_object('method', 'installment', 'dueDate', p_delivery + 30, 'percentBp', 3333),
      jsonb_build_object('method', 'installment', 'dueDate', p_delivery + 60, 'percentBp', 3333),
      jsonb_build_object('method', 'installment', 'dueDate', p_delivery + 90, 'percentBp', 3334));
  ELSIF v_preset = 'cheque30' THEN
    v_items := jsonb_build_array(jsonb_build_object('method', 'cheque', 'dueDate', p_delivery + 30, 'percentBp', 10000));
  ELSIF v_preset = 'custom' THEN
    v_items := p_plan -> 'items';
  ELSE
    RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation';
  END IF;
  v_n := jsonb_array_length(v_items);
  FOR v_i IN 0 .. v_n - 1 LOOP
    v_item := v_items -> v_i;
    v_method := v_item ->> 'method';
    IF v_method IS NULL OR v_method NOT IN ('cash', 'cheque', 'lcn', 'transfer', 'advance', 'installment') THEN
      RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      v_due := (v_item ->> 'dueDate')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation';
    END;
    v_methods := v_methods || v_method;
    v_dues := v_dues || v_due;
    IF v_item ? 'percentBp' THEN
      v_percent := v_percent + 1;
      v_bp := (v_item ->> 'percentBp')::integer;
      IF v_bp <= 0 THEN RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation'; END IF;
      v_bps := v_bps || v_bp;
      v_bp_sum := v_bp_sum + v_bp;
    ELSE
      v_fixed := v_fixed + 1;
      v_amt := (v_item ->> 'amountCentimes')::bigint;
      IF v_amt IS NULL OR v_amt <= 0 THEN RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation'; END IF;
      v_amounts := v_amounts || v_amt;
      v_amt_sum := v_amt_sum + v_amt;
    END IF;
  END LOOP;
  IF v_percent > 0 AND v_fixed > 0 THEN
    RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF v_percent > 0 THEN
    IF v_bp_sum <> 10000 THEN RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation'; END IF;
    v_amounts := '{}';
    FOR v_i IN 1 .. v_n LOOP
      IF v_i = v_n THEN
        v_amt := v_ttc - v_allocated;
      ELSE
        v_amt := public.scale_qty(v_ttc, v_bps[v_i], 10000);
      END IF;
      IF v_amt <= 0 THEN RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation'; END IF;
      v_allocated := v_allocated + v_amt;
      v_amounts := v_amounts || v_amt;
    END LOOP;
  ELSIF v_amt_sum <> v_ttc THEN
    RAISE EXCEPTION 'create_order: payment plan invalid' USING ERRCODE = 'check_violation';
  END IF;

  v_code := public.next_doc_number('CMD', extract(year FROM p_today)::integer, 5);
  INSERT INTO public.sales_order (id, code, client_id, site_id, zone_id, concrete_type_id, volume_l, order_date, delivery_date,
                                  selling_price_id, unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes,
                                  total_ttc_centimes, brought_by_user_id, reason, quote_id, created_by)
  VALUES (v_id, v_code, p_client, p_site, v_zone, p_type, p_volume_l, p_today, p_delivery, v_price.id,
          v_price.price_ht_per_m3_centimes, v_vat, v_ht, v_vatamt, v_ttc, p_brought_by, NULL, p_quote, v_user);
  FOR v_i IN 1 .. v_n LOOP
    INSERT INTO public.payment_plan_item (id, order_id, seq, direction, method, due_date, amount_centimes, created_by)
    VALUES (gen_random_uuid(), v_id, v_i, 'in', v_methods[v_i], v_dues[v_i], v_amounts[v_i], v_user);
  END LOOP;
  RETURN QUERY SELECT v_code, v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_order(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_order(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer) TO belgobeton_app;
--> statement-breakpoint

CREATE FUNCTION public.create_quote(p_client uuid, p_type uuid, p_volume_l integer, p_valid_days integer, p_today date, p_vat_default integer)
RETURNS TABLE (code text, id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role   text := ctx.role();
  v_user   uuid := ctx.user_id();
  v_price  record;
  v_vat    integer;
  v_ht     bigint;
  v_vatamt bigint;
  v_id     uuid := gen_random_uuid();
  v_code   text;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office') THEN
    RAISE EXCEPTION 'create_quote: role % may not create a quote', coalesce(v_role, '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_volume_l IS NULL OR p_volume_l < 1 OR p_volume_l > 100000000 OR p_today IS NULL
     OR p_valid_days IS NULL OR p_valid_days < 1 OR p_valid_days > 180 THEN
    RAISE EXCEPTION 'create_quote: invalid volume or validity' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.client c WHERE c.id = p_client) THEN
    RAISE EXCEPTION 'create_quote: unknown client' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.concrete_type t WHERE t.id = p_type) THEN
    RAISE EXCEPTION 'create_quote: unknown concrete type' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT * INTO v_price FROM public._price_in_force(p_type, p_client, p_today);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_quote: the price is not the one in force' USING ERRCODE = 'check_violation';
  END IF;
  SELECT (p.value #>> '{}')::integer INTO v_vat FROM public.parameter p WHERE p.key = 'vat_rate_bp';
  v_vat := coalesce(v_vat, p_vat_default);
  IF v_vat IS NULL OR v_vat < 0 OR v_vat > 10000 THEN
    RAISE EXCEPTION 'create_quote: invalid VAT rate' USING ERRCODE = 'check_violation';
  END IF;
  v_ht := public.scale_qty(v_price.price_ht_per_m3_centimes, p_volume_l, 1000);
  v_vatamt := public.scale_qty(v_ht, v_vat, 10000);
  v_code := public.next_doc_number('DV', extract(year FROM p_today)::integer, 5);
  INSERT INTO public.quote (id, code, client_id, concrete_type_id, volume_l, quote_date, valid_until, selling_price_id,
                            unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
  VALUES (v_id, v_code, p_client, p_type, p_volume_l, p_today, p_today + p_valid_days, v_price.id,
          v_price.price_ht_per_m3_centimes, v_vat, v_ht, v_vatamt, v_ht + v_vatamt, v_user);
  RETURN QUERY SELECT v_code, v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_quote(uuid, uuid, integer, integer, date, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_quote(uuid, uuid, integer, integer, date, integer) TO belgobeton_app;
