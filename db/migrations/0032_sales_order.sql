-- ledger L3 (plan: order + payment plan; DECISIONS 81 blind entry): `sales_order` (the plan's `order`, a reserved word) and
-- `payment_plan_item`. Insert-only: no UPDATE, DELETE or TRUNCATE grant anywhere; a correction is a reversing row (L5).
-- Money: amounts are integer centimes. Owner and support read the tables; office INSERTS and never reads them back
-- (no SELECT policy, so no RETURNING either); partner and plant read the operational view sales_order_ops only.
-- Invariants live here, not only in the service: Σ plan items = order TTC (deferred constraint trigger), totals add up
-- (CHECK), the price is the one in force (guard trigger), an archived client cannot get a new order.

CREATE TABLE public.sales_order (
  id                     uuid PRIMARY KEY,
  code                   text   NOT NULL UNIQUE CHECK (code ~ '^CMD-[0-9]{4}-[0-9]{5,}$'),
  client_id              uuid   NOT NULL REFERENCES public.client (id),
  site_id                uuid   REFERENCES public.client_site (id),
  zone_id                uuid   REFERENCES public.zone (id),
  concrete_type_id       uuid   NOT NULL REFERENCES public.concrete_type (id),
  volume_l               integer NOT NULL CHECK (volume_l <> 0),
  order_date             date   NOT NULL,
  delivery_date          date   NOT NULL,
  selling_price_id       uuid   NOT NULL REFERENCES public.selling_price (id),
  unit_price_ht_centimes bigint NOT NULL CHECK (unit_price_ht_centimes > 0),
  -- The VAT rate in force when the order was created (parameter vat_rate_bp), kept for good.
  vat_rate_bp            integer NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  total_ht_centimes      bigint NOT NULL,
  total_vat_centimes     bigint NOT NULL,
  total_ttc_centimes     bigint NOT NULL,
  -- Who brought the order (owner or partner, DECISIONS 3); optional.
  brought_by_user_id     uuid,
  -- A reversal row (L5) negates its original and carries the mandatory reason; L6 reuses `reason` for a price override.
  reverses_id            uuid   UNIQUE REFERENCES public.sales_order (id),
  reason                 text   CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by             uuid   NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (total_ttc_centimes = total_ht_centimes + total_vat_centimes),
  CHECK (delivery_date >= order_date),
  CHECK (
    (reverses_id IS NULL AND volume_l > 0 AND total_ttc_centimes > 0)
    OR (reverses_id IS NOT NULL AND volume_l < 0 AND total_ttc_centimes < 0 AND reason IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX sales_order_client_idx ON public.sales_order (client_id);
--> statement-breakpoint
CREATE INDEX sales_order_delivery_idx ON public.sales_order (delivery_date);
--> statement-breakpoint
CREATE TABLE public.payment_plan_item (
  id               uuid PRIMARY KEY,
  order_id         uuid    NOT NULL REFERENCES public.sales_order (id),
  seq              integer NOT NULL CHECK (seq >= 1),
  direction        text    NOT NULL CHECK (direction IN ('in', 'out')),
  -- How we expect to be paid; an instrument (L10) is what actually arrives.
  method           text    NOT NULL CHECK (method IN ('cash', 'cheque', 'lcn', 'transfer', 'advance', 'installment')),
  due_date         date    NOT NULL,
  amount_centimes  bigint  NOT NULL CHECK (amount_centimes <> 0),
  reverses_id      uuid    UNIQUE REFERENCES public.payment_plan_item (id),
  created_by       uuid    NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seq)
);
--> statement-breakpoint
CREATE INDEX payment_plan_item_order_idx ON public.payment_plan_item (order_id);
--> statement-breakpoint

-- Helpers that read what office may not read, for office's own writes. SECURITY DEFINER, role-checked, fixed search_path.
-- The migrator owns the tables and is subject to FORCE RLS, so each gets a read policy for that role only.
CREATE POLICY selling_price_definer_read ON public.selling_price FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY parameter_definer_read ON public.parameter FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY client_definer_read ON public.client FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY client_site_definer_read ON public.client_site FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY concrete_type_definer_read ON public.concrete_type FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY sales_order_definer_read ON public.sales_order FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY payment_plan_item_definer_read ON public.payment_plan_item FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- The selling price in force for a client on a date: the client's override when one is in force, else the list price
-- (same rule as master-data resolveSellingPrice, AC-MD-03). Office needs it to create an order and may not read prices.
CREATE FUNCTION public.resolve_selling_price(p_type uuid, p_client uuid, p_date date)
RETURNS TABLE (id uuid, price_ht_per_m3_centimes bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'resolve_selling_price: role % may not resolve a price', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT sp.id, sp.price_ht_per_m3_centimes FROM public.selling_price sp
     WHERE sp.concrete_type_id = p_type AND sp.effective_from <= p_date AND (sp.client_id = p_client OR sp.client_id IS NULL)
     ORDER BY (sp.client_id IS NOT NULL) DESC, sp.effective_from DESC
     LIMIT 1;
END $$;
--> statement-breakpoint
-- The ledger parameters (VAT rate, reversal window, clearing delay), for the roles that create documents.
CREATE FUNCTION public.ledger_parameter(p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'ledger_parameter: role % may not read parameters', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key NOT IN ('vat_rate_bp', 'reversal_window_days', 'clearing_delay_days') THEN
    RAISE EXCEPTION 'ledger_parameter: % is not a ledger parameter', p_key USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT p.value FROM public.parameter p WHERE p.key = p_key);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_selling_price(uuid, uuid, date) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.ledger_parameter(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_selling_price(uuid, uuid, date) TO belgobeton_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ledger_parameter(text) TO belgobeton_app;
--> statement-breakpoint

-- Guard on a new order: the client is active, the site belongs to the client, the type is active, the price is the one
-- in force (unless a reason says otherwise: L6), who brought it is an owner or partner.
CREATE FUNCTION public.sales_order_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_price  record;
  v_res    record;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.sales_order o WHERE o.id = NEW.reverses_id AND o.reverses_id IS NOT NULL) THEN
      RAISE EXCEPTION 'sales_order: a reversal cannot be reversed' USING ERRCODE = 'check_violation';
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
  SELECT sp.concrete_type_id, sp.price_ht_per_m3_centimes AS price INTO v_price
    FROM public.selling_price sp WHERE sp.id = NEW.selling_price_id;
  IF NOT FOUND OR v_price.concrete_type_id <> NEW.concrete_type_id THEN
    RAISE EXCEPTION 'sales_order: unknown price for this concrete type' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reason IS NULL THEN
    SELECT r.id, r.price_ht_per_m3_centimes AS price INTO v_res
      FROM public.resolve_selling_price(NEW.concrete_type_id, NEW.client_id, NEW.order_date) r;
    IF v_res.id IS DISTINCT FROM NEW.selling_price_id OR v_price.price <> NEW.unit_price_ht_centimes THEN
      RAISE EXCEPTION 'sales_order: the price is not the one in force on %', NEW.order_date USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.brought_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."user" u WHERE u.id = NEW.brought_by_user_id::text AND u.role IN ('owner', 'partner')
  ) THEN
    RAISE EXCEPTION 'sales_order: brought_by must be the owner or the partner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_order_guard BEFORE INSERT ON public.sales_order
  FOR EACH ROW EXECUTE FUNCTION public.sales_order_guard();
--> statement-breakpoint

-- Σ plan items = order TTC, checked when the transaction commits (the order and its items arrive together).
CREATE FUNCTION public.payment_plan_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order uuid;
  v_total bigint;
  v_sum   bigint;
BEGIN
  IF TG_TABLE_NAME = 'sales_order' THEN
    v_order := NEW.id;
  ELSE
    v_order := NEW.order_id;
  END IF;
  SELECT o.total_ttc_centimes INTO v_total FROM public.sales_order o WHERE o.id = v_order;
  SELECT coalesce(sum(i.amount_centimes), 0) INTO v_sum FROM public.payment_plan_item i WHERE i.order_id = v_order;
  IF v_total IS NULL OR v_sum <> v_total THEN
    RAISE EXCEPTION 'payment plan of order % adds up to %, the order total is %', v_order, v_sum, coalesce(v_total::text, '(none)')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sales_order_plan_balanced AFTER INSERT ON public.sales_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payment_plan_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_plan_item_balanced AFTER INSERT ON public.payment_plan_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payment_plan_balanced();
--> statement-breakpoint
-- An order item always points in: purchases (L20) will add the outgoing kind with their own table link.
CREATE FUNCTION public.payment_plan_item_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_reverses_order uuid;
BEGIN
  IF NEW.direction <> 'in' THEN
    RAISE EXCEPTION 'payment_plan_item: an order item is incoming' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT i.order_id INTO v_reverses_order FROM public.payment_plan_item i WHERE i.id = NEW.reverses_id;
    IF NOT EXISTS (
      SELECT 1 FROM public.sales_order o WHERE o.id = NEW.order_id AND o.reverses_id = v_reverses_order
    ) THEN
      RAISE EXCEPTION 'payment_plan_item: a reversal item belongs to the reversal of its original order'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_plan_item_guard BEFORE INSERT ON public.payment_plan_item
  FOR EACH ROW EXECUTE FUNCTION public.payment_plan_item_guard();
--> statement-breakpoint

ALTER TABLE public.sales_order ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sales_order FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_plan_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_plan_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.sales_order, public.payment_plan_item FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.sales_order, public.payment_plan_item TO belgobeton_app;
--> statement-breakpoint
-- Owner and support read (support through support_read). Office inserts and cannot read back; partner and plant have
-- no policy on the base tables at all.
CREATE POLICY sales_order_read ON public.sales_order FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY sales_order_insert ON public.sales_order FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'office') AND created_by = ctx.user_id() AND reverses_id IS NULL AND reason IS NULL);
--> statement-breakpoint
CREATE POLICY payment_plan_item_read ON public.payment_plan_item FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY payment_plan_item_insert ON public.payment_plan_item FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'office') AND created_by = ctx.user_id() AND reverses_id IS NULL AND direction = 'in');
--> statement-breakpoint
SELECT public.grant_support_read('public.sales_order');
--> statement-breakpoint
SELECT public.grant_support_read('public.payment_plan_item');
--> statement-breakpoint
SELECT audit.attach('public.sales_order');
--> statement-breakpoint
SELECT audit.attach('public.payment_plan_item');
--> statement-breakpoint

-- The audit rows of the two tables hold amounts: only owner and support read them (DECISIONS 81).
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item')
$$;
--> statement-breakpoint

-- What the plant and the partner see of an order: operational fields only (code, concrete type, volume, delivery date,
-- client code, site label, zone). No price, total, plan or client contact (AC-SEC-05). A view, because the single
-- database role cannot tell the plant from the owner at column level; the request role is checked inside.
CREATE VIEW public.sales_order_ops AS
  SELECT o.id, o.code, o.concrete_type_id, o.volume_l, o.delivery_date, o.zone_id, o.site_id,
         c.code AS client_code, s.label AS site_label, o.reverses_id
    FROM public.sales_order o
    JOIN public.client c ON c.id = o.client_id
    LEFT JOIN public.client_site s ON s.id = o.site_id
   WHERE ctx.role() IN ('owner', 'support', 'partner', 'plant');
--> statement-breakpoint
REVOKE ALL ON public.sales_order_ops FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.sales_order_ops TO belgobeton_app;
