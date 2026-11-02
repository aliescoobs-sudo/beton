-- R3 (CP-PROD-PLAN, REQUIREMENTS-V1 §4, §5, §12; DECISIONS 130 to 132, 140): provisional prices, credit holds, one approvals inbox.
-- The list selling price is the reference average price (global in R3; per plant is a later step, D140). An order made by
-- office_sales takes it as a PROVISIONAL price: the order stores it as before, a side row says it is not confirmed, and no
-- invoice can bill it until the owner or app_admin confirms the real price. Nothing is edited: the confirmation is a row,
-- and invoices bill `order_price(order)` (the confirmed price when there is one).

-- The credit limit of a client: money, owner and app_admin write, support reads (D81 style).
CREATE TABLE public.client_credit_limit (
  client_id      uuid PRIMARY KEY REFERENCES public.client(id),
  limit_centimes bigint NOT NULL CHECK (limit_centimes > 0),
  set_by         uuid NOT NULL,
  set_at         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One row per provisional order; confirmed_at is set once, by confirm_order_price (a definer function).
CREATE TABLE public.order_price_status (
  order_id                         uuid PRIMARY KEY REFERENCES public.sales_order(id),
  provisional_unit_price_centimes  bigint NOT NULL CHECK (provisional_unit_price_centimes > 0),
  confirmed_unit_price_centimes    bigint CHECK (confirmed_unit_price_centimes > 0),
  confirmed_by                     uuid,
  confirmed_at                     timestamptz,
  created_by                       uuid NOT NULL,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL) AND (confirmed_at IS NULL) = (confirmed_unit_price_centimes IS NULL))
);
--> statement-breakpoint
-- A held order (credit limit exceeded, or the client has overdue invoices) waits for the owner or app_admin. No amount here.
CREATE TABLE public.order_hold (
  order_id    uuid PRIMARY KEY REFERENCES public.sales_order(id),
  reason      text NOT NULL CHECK (reason IN ('credit_limit', 'overdue')),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  note        text CHECK (note IS NULL OR length(note) <= 500),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['client_credit_limit', 'order_price_status', 'order_hold'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''owner'')', t || '_read', t);
    EXECUTE format('CREATE POLICY support_read ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''support'')', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('SELECT audit.attach(''public.%I'')', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line', 'quote',
                     'alert', 'alert_event', 'cash_decision', 'fuel_purchase', 'invoice_advance', 'avoir',
                     'supplier_invoice', 'supplier_invoice_line', 'supplier_invoice_receipt', 'supplier_invoice_event',
                     'supplier_invoice_file', 'client_credit_limit', 'order_price_status')
$$;
--> statement-breakpoint

-- The price an order is billed at: the confirmed one when the owner confirmed a different price, else its own.
CREATE FUNCTION public.order_price(p_order uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT s.confirmed_unit_price_centimes FROM public.order_price_status s WHERE s.order_id = p_order),
                  (SELECT o.unit_price_ht_centimes FROM public.sales_order o WHERE o.id = p_order))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.order_price(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.order_price(uuid) TO belgobeton_migrator;
--> statement-breakpoint
-- Invoices bill the confirmed price: the four places of the invoice function that read the order's price now read order_price().
DO $$
DECLARE v text;
BEGIN
  v := pg_get_functiondef('public.create_invoice_from_deliveries__inner(uuid[], date, date)'::regprocedure);
  IF position('o.unit_price_ht_centimes' IN v) = 0 THEN RAISE EXCEPTION 'invoice function changed shape'; END IF;
  v := replace(v, 'o.unit_price_ht_centimes', 'public.order_price(o.id)');
  EXECUTE v;
END $$;
--> statement-breakpoint
-- The two guards that compare an invoice line with the order's price compare it with the price the order is billed at.
DO $$
DECLARE f text; v text;
BEGIN
  FOREACH f IN ARRAY ARRAY['invoice_line_guard', 'invoice_line_price_guard'] LOOP
    v := pg_get_functiondef(('public.' || f || '()')::regprocedure);
    IF position('v_o.unit_price_ht_centimes' IN v) = 0 THEN RAISE EXCEPTION '% changed shape', f; END IF;
    EXECUTE replace(v, 'v_o.unit_price_ht_centimes', 'public.order_price(v_o.id)');
  END LOOP;
END $$;
--> statement-breakpoint
-- No invoice line for a load of a provisional order, whatever door wrote it (database rule).
CREATE FUNCTION public.invoice_line_provisional_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.delivery d JOIN public.order_price_status s ON s.order_id = d.order_id
              WHERE d.id = NEW.delivery_id AND s.confirmed_at IS NULL) THEN
    RAISE EXCEPTION 'invoice: the price of this order is provisional, the owner must confirm it first'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.invoice_line_provisional_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER invoice_line_provisional_guard BEFORE INSERT ON public.invoice_line
  FOR EACH ROW EXECUTE FUNCTION public.invoice_line_provisional_guard();
--> statement-breakpoint
-- A held order is not loaded until the owner or app_admin releases it.
CREATE FUNCTION public.delivery_hold_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.reverses_id IS NULL AND EXISTS (SELECT 1 FROM public.order_hold h WHERE h.order_id = NEW.order_id AND h.released_at IS NULL) THEN
    RAISE EXCEPTION 'delivery: the order is waiting for approval' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.delivery_hold_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER a_delivery_hold_guard BEFORE INSERT ON public.delivery
  FOR EACH ROW EXECUTE FUNCTION public.delivery_hold_guard();
--> statement-breakpoint

-- What a client owes on the plan items of its live orders (open = planned - allocated), and what is overdue.
CREATE FUNCTION public.client_open_centimes(p_client uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(sum(i.amount_centimes - coalesce((SELECT sum(a.amount_centimes) FROM public.allocation a WHERE a.payment_plan_item_id = i.id), 0)), 0)::bigint
    FROM public.payment_plan_item i JOIN public.sales_order o ON o.id = i.order_id
   WHERE o.client_id = p_client AND i.direction = 'in'
$$;
--> statement-breakpoint
CREATE FUNCTION public.client_overdue(p_client uuid, p_today date) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.payment_plan_item i JOIN public.sales_order o ON o.id = i.order_id
     WHERE o.client_id = p_client AND i.direction = 'in' AND i.reverses_id IS NULL AND i.due_date < p_today
       AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
       AND i.amount_centimes - coalesce((SELECT sum(a.amount_centimes) FROM public.allocation a WHERE a.payment_plan_item_id = i.id), 0) > 0)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.client_open_centimes(uuid), public.client_overdue(uuid, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.client_open_centimes(uuid), public.client_overdue(uuid, date) TO belgobeton_migrator;
--> statement-breakpoint

-- create_order keeps its sales/purchases wrapper and gains the V1 rules: an office_sales order is provisional, and an
-- order over the client's credit limit or from a client with overdue invoices is held.
CREATE OR REPLACE FUNCTION public.create_order(p_client uuid, p_site uuid, p_zone uuid, p_type uuid, p_volume_l integer, p_delivery date, p_today date, p_brought_by uuid, p_quote uuid, p_plan jsonb, p_vat_default integer)
  RETURNS TABLE(code text, id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_code text;
  v_id   uuid;
  v_limit bigint;
  v_total bigint;
  v_open  bigint;
BEGIN
  IF ctx.actor_role() = 'office_purchases' THEN
    RAISE EXCEPTION 'create_order: role % may not use this door', ctx.actor_role() USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.code, r.id INTO v_code, v_id FROM public.create_order__inner(p_client, p_site, p_zone, p_type, p_volume_l, p_delivery, p_today, p_brought_by, p_quote, p_plan, p_vat_default) r;
  IF ctx.actor_role() = 'office_sales' THEN
    INSERT INTO public.order_price_status (order_id, provisional_unit_price_centimes, created_by)
    SELECT o.id, o.unit_price_ht_centimes, ctx.user_id() FROM public.sales_order o WHERE o.id = v_id;
  END IF;
  IF ctx.role() NOT IN ('owner', 'system') THEN
    SELECT l.limit_centimes INTO v_limit FROM public.client_credit_limit l WHERE l.client_id = p_client;
    SELECT o.total_ttc_centimes INTO v_total FROM public.sales_order o WHERE o.id = v_id;
    -- the new order is already on the client's plan items: what was open before it is the open total minus its own total
    v_open := public.client_open_centimes(p_client) - v_total;
    IF public.client_overdue(p_client, p_today) THEN
      INSERT INTO public.order_hold (order_id, reason, created_by) VALUES (v_id, 'overdue', ctx.user_id());
    ELSIF v_limit IS NOT NULL AND v_open + v_total > v_limit THEN
      INSERT INTO public.order_hold (order_id, reason, created_by) VALUES (v_id, 'credit_limit', ctx.user_id());
    END IF;
  END IF;
  RETURN QUERY SELECT v_code, v_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.create_order(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_order(uuid, uuid, uuid, uuid, integer, date, date, uuid, uuid, jsonb, integer) TO belgobeton_app;
--> statement-breakpoint

-- The owner and app_admin (policy role owner) decide. Each is one reviewed door; the tables are audited.
CREATE FUNCTION public.confirm_order_price(p_order uuid, p_unit_price bigint) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s public.order_price_status%ROWTYPE; v_price bigint;
BEGIN
  IF ctx.role() IS NULL OR ctx.role() <> 'owner' THEN
    RAISE EXCEPTION 'confirm_order_price: role % may not confirm a price', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_s FROM public.order_price_status WHERE order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'confirm_order_price: this order has no provisional price' USING ERRCODE = 'check_violation'; END IF;
  IF v_s.confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'confirm_order_price: already confirmed' USING ERRCODE = 'unique_violation'; END IF;
  v_price := coalesce(p_unit_price, v_s.provisional_unit_price_centimes);
  IF v_price <= 0 THEN RAISE EXCEPTION 'confirm_order_price: invalid price' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.order_price_status SET confirmed_unit_price_centimes = v_price, confirmed_by = ctx.user_id(), confirmed_at = now()
   WHERE order_id = p_order;
  RETURN v_price;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.release_order_hold(p_order uuid, p_note text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() <> 'owner' THEN
    RAISE EXCEPTION 'release_order_hold: role % may not release an order', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.order_hold SET released_by = ctx.user_id(), released_at = now(), note = nullif(btrim(p_note), '')
   WHERE order_id = p_order AND released_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'release_order_hold: nothing to release' USING ERRCODE = 'check_violation'; END IF;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.set_client_credit_limit(p_client uuid, p_limit bigint) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() <> 'owner' THEN
    RAISE EXCEPTION 'set_client_credit_limit: role % may not set a limit', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL THEN
    DELETE FROM public.client_credit_limit WHERE client_id = p_client;
    RETURN true;
  END IF;
  INSERT INTO public.client_credit_limit (client_id, limit_centimes, set_by) VALUES (p_client, p_limit, ctx.user_id())
  ON CONFLICT (client_id) DO UPDATE SET limit_centimes = EXCLUDED.limit_centimes, set_by = EXCLUDED.set_by, set_at = now();
  RETURN true;
END $$;
--> statement-breakpoint

-- The approvals inbox (owner and app_admin): what waits, with the figures that will be written. One row per card.
CREATE FUNCTION public.approvals_pending() RETURNS TABLE(
  kind text, order_id uuid, order_code text, client_code text, client_name text, volume_l integer,
  unit_price_centimes bigint, total_ht_centimes bigint, reason text, open_centimes bigint, limit_centimes bigint, created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'support') THEN
    RAISE EXCEPTION 'approvals_pending: role % may not read the approvals', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT 'price'::text, o.id, o.code, c.code, c.name, o.volume_l, s.provisional_unit_price_centimes,
         public.scale_qty(s.provisional_unit_price_centimes, o.volume_l, 1000), NULL::text, NULL::bigint, NULL::bigint, s.created_at
    FROM public.order_price_status s JOIN public.sales_order o ON o.id = s.order_id JOIN public.client c ON c.id = o.client_id
   WHERE s.confirmed_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
  UNION ALL
  SELECT 'credit'::text, o.id, o.code, c.code, c.name, o.volume_l, o.unit_price_ht_centimes, o.total_ht_centimes, h.reason,
         public.client_open_centimes(o.client_id), (SELECT l.limit_centimes FROM public.client_credit_limit l WHERE l.client_id = o.client_id), h.created_at
    FROM public.order_hold h JOIN public.sales_order o ON o.id = h.order_id JOIN public.client c ON c.id = o.client_id
   WHERE h.released_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
  ORDER BY 12, 3;
END $$;
--> statement-breakpoint
-- What office and the others may know without any figure: whether an order waits (price not confirmed, or held).
CREATE FUNCTION public.order_approval_state() RETURNS TABLE(order_id uuid, code text, state text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'office', 'support', 'system') THEN
    RAISE EXCEPTION 'order_approval_state: role % may not read it', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT o.id, o.code,
         CASE WHEN EXISTS (SELECT 1 FROM public.order_hold h WHERE h.order_id = o.id AND h.released_at IS NULL) THEN 'pending_approval'
              WHEN EXISTS (SELECT 1 FROM public.order_price_status s WHERE s.order_id = o.id AND s.confirmed_at IS NULL) THEN 'price_provisional'
              ELSE 'ok' END
    FROM public.sales_order o
   WHERE o.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id)
     AND (EXISTS (SELECT 1 FROM public.order_hold h WHERE h.order_id = o.id AND h.released_at IS NULL)
          OR EXISTS (SELECT 1 FROM public.order_price_status s WHERE s.order_id = o.id AND s.confirmed_at IS NULL));
END $$;
--> statement-breakpoint
-- Office sees a client's standing as two words, never a figure: owes / does not owe, late / not late.
CREATE FUNCTION public.client_balance_status(p_today date) RETURNS TABLE(client_id uuid, client_code text, owes boolean, late boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'office', 'support', 'system') THEN
    RAISE EXCEPTION 'client_balance_status: role % may not read it', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT c.id, c.code, public.client_open_centimes(c.id) > 0, public.client_overdue(c.id, p_today)
    FROM public.client c WHERE c.status = 'active' ORDER BY c.code;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['confirm_order_price(uuid, bigint)', 'release_order_hold(uuid, text)', 'set_client_credit_limit(uuid, bigint)',
                           'approvals_pending()', 'order_approval_state()', 'client_balance_status(date)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
END $$;
