-- ledger L20 (SPEC-ledger purchases, AC-LED-16, law 69-21): a purchase from a supplier with its lines and its payment plan
-- (the outgoing side). Same pattern as the sales order (L3, L5): insert-only (no UPDATE, DELETE or TRUNCATE grant), a
-- correction is a reversing row, totals and plan are checked by the database, office enters blind (INSERT only, no
-- SELECT), owner and support read, partner and plant read the receipt view only (quantities, no price).
-- Deviation from the plan: the outgoing plan items live in their own table (`purchase_plan_item`) rather than in
-- `payment_plan_item`, whose foreign key and guards are the sales order's; supplier payments (L22) will allocate to them.

CREATE TABLE public.purchase (
  id                    uuid PRIMARY KEY,
  code                  text   NOT NULL UNIQUE CHECK (code ~ '^ACH-[0-9]{4}-[0-9]{5,}$'),
  supplier_id           uuid   NOT NULL REFERENCES public.supplier (id),
  order_date            date   NOT NULL,
  supplier_invoice_no   text   CHECK (supplier_invoice_no = btrim(supplier_invoice_no) AND length(supplier_invoice_no) BETWEEN 1 AND 60),
  supplier_invoice_date date,
  -- Law 69-21: at most 120 days after the supplier's invoice (or the order when there is no invoice yet).
  due_date              date   NOT NULL,
  vat_rate_bp           integer NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  total_ht_centimes     bigint NOT NULL,
  total_vat_centimes    bigint NOT NULL,
  total_ttc_centimes    bigint NOT NULL,
  reverses_id           uuid   UNIQUE REFERENCES public.purchase (id),
  reason                text   CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by            uuid   NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (total_ttc_centimes = total_ht_centimes + total_vat_centimes),
  CHECK (due_date >= order_date AND due_date <= coalesce(supplier_invoice_date, order_date) + 120),
  CHECK (
    (reverses_id IS NULL AND total_ttc_centimes > 0)
    OR (reverses_id IS NOT NULL AND total_ttc_centimes < 0 AND reason IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX purchase_supplier_idx ON public.purchase (supplier_id);
--> statement-breakpoint
CREATE TABLE public.purchase_line (
  id                     uuid PRIMARY KEY,
  purchase_id            uuid    NOT NULL REFERENCES public.purchase (id),
  seq                    integer NOT NULL CHECK (seq >= 1),
  -- A stocked component with its purchase unit, or a service (transport, fuel) described in words.
  component_id           uuid    REFERENCES public.component (id),
  purchase_unit_id       uuid    REFERENCES public.purchase_unit (id),
  description            text    CHECK (description = btrim(description) AND length(description) BETWEEN 1 AND 200),
  -- Thousandths of the purchase unit (2,5 t = 2500): never a float.
  qty_milli              bigint  NOT NULL CHECK (qty_milli > 0),
  unit_price_ht_centimes bigint  NOT NULL CHECK (unit_price_ht_centimes > 0),
  line_ht_centimes       bigint  NOT NULL CHECK (line_ht_centimes > 0),
  created_by             uuid    NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_id, seq),
  CHECK ((component_id IS NULL) = (purchase_unit_id IS NULL)),
  CHECK (component_id IS NOT NULL OR description IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE public.purchase_plan_item (
  id              uuid PRIMARY KEY,
  purchase_id     uuid    NOT NULL REFERENCES public.purchase (id),
  seq             integer NOT NULL CHECK (seq >= 1),
  method          text    NOT NULL CHECK (method IN ('cash', 'cheque', 'lcn', 'transfer', 'advance', 'installment')),
  due_date        date    NOT NULL,
  amount_centimes bigint  NOT NULL CHECK (amount_centimes <> 0),
  reverses_id     uuid    UNIQUE REFERENCES public.purchase_plan_item (id),
  created_by      uuid    NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_id, seq)
);
--> statement-breakpoint
CREATE INDEX purchase_plan_item_purchase_idx ON public.purchase_plan_item (purchase_id);
--> statement-breakpoint

-- The migrator owns the tables and is subject to FORCE RLS: the definer functions and the view read through these.
CREATE POLICY purchase_definer_read ON public.purchase FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY purchase_line_definer_read ON public.purchase_line FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY purchase_plan_item_definer_read ON public.purchase_plan_item FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY component_definer_read ON public.component FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY purchase_unit_definer_read ON public.purchase_unit FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- Guard on a purchase: a new one needs an active supplier; a reversal negates its original exactly, once.
CREATE FUNCTION public.purchase_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_orig   public.purchase%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.purchase p WHERE p.id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase: unknown purchase to reverse' USING ERRCODE = 'check_violation';
    END IF;
    IF v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'purchase: a reversal cannot be reversed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.supplier_id <> v_orig.supplier_id OR NEW.order_date <> v_orig.order_date OR NEW.due_date <> v_orig.due_date
       OR NEW.supplier_invoice_no IS DISTINCT FROM v_orig.supplier_invoice_no
       OR NEW.supplier_invoice_date IS DISTINCT FROM v_orig.supplier_invoice_date
       OR NEW.vat_rate_bp <> v_orig.vat_rate_bp
       OR NEW.total_ht_centimes <> -v_orig.total_ht_centimes OR NEW.total_vat_centimes <> -v_orig.total_vat_centimes
       OR NEW.total_ttc_centimes <> -v_orig.total_ttc_centimes THEN
      RAISE EXCEPTION 'purchase: a reversal negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT s.status INTO v_status FROM public.supplier s WHERE s.id = NEW.supplier_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'purchase: the supplier is not active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_guard BEFORE INSERT ON public.purchase
  FOR EACH ROW EXECUTE FUNCTION public.purchase_guard();
--> statement-breakpoint

-- Guard on a line: only on an original purchase, the unit belongs to the component, and the line total is the quantity
-- times the unit price, rounded once (the SQL twin of mulDivRound; same function as the stock quantities).
CREATE FUNCTION public.purchase_line_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.purchase p WHERE p.id = NEW.purchase_id AND p.reverses_id IS NULL) THEN
    RAISE EXCEPTION 'purchase_line: lines belong to an original purchase' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purchase_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.purchase_unit u WHERE u.id = NEW.purchase_unit_id AND u.component_id = NEW.component_id
  ) THEN
    RAISE EXCEPTION 'purchase_line: the unit does not belong to the component' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.line_ht_centimes <> public.scale_qty(NEW.unit_price_ht_centimes, NEW.qty_milli, 1000) THEN
    RAISE EXCEPTION 'purchase_line: the line total is not quantity times price' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_line_guard BEFORE INSERT ON public.purchase_line
  FOR EACH ROW EXECUTE FUNCTION public.purchase_line_guard();
--> statement-breakpoint

CREATE FUNCTION public.purchase_plan_item_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_orig public.purchase_plan_item%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.purchase_plan_item i WHERE i.id = NEW.reverses_id;
    IF NOT FOUND OR v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'purchase_plan_item: a reversal item reverses an original item' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.purchase p WHERE p.id = NEW.purchase_id AND p.reverses_id = v_orig.purchase_id
    ) THEN
      RAISE EXCEPTION 'purchase_plan_item: a reversal item belongs to the reversal of its original purchase'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_centimes <> -v_orig.amount_centimes OR NEW.method <> v_orig.method OR NEW.due_date <> v_orig.due_date THEN
      RAISE EXCEPTION 'purchase_plan_item: a reversal item negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_plan_item_guard BEFORE INSERT ON public.purchase_plan_item
  FOR EACH ROW EXECUTE FUNCTION public.purchase_plan_item_guard();
--> statement-breakpoint

-- At commit: Σ lines = total HT (original purchases) and Σ plan items = total TTC (AC-LED-02), whichever table arrives last.
CREATE FUNCTION public.purchase_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id    uuid;
  v_p     public.purchase%ROWTYPE;
  v_lines bigint;
  v_plan  bigint;
BEGIN
  IF TG_TABLE_NAME = 'purchase' THEN
    v_id := NEW.id;
  ELSE
    v_id := NEW.purchase_id;
  END IF;
  SELECT * INTO v_p FROM public.purchase p WHERE p.id = v_id;
  SELECT coalesce(sum(i.amount_centimes), 0) INTO v_plan FROM public.purchase_plan_item i WHERE i.purchase_id = v_id;
  IF v_plan <> v_p.total_ttc_centimes THEN
    RAISE EXCEPTION 'payment plan of purchase % adds up to %, the purchase total is %', v_id, v_plan, v_p.total_ttc_centimes
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_p.reverses_id IS NULL THEN
    SELECT coalesce(sum(l.line_ht_centimes), 0) INTO v_lines FROM public.purchase_line l WHERE l.purchase_id = v_id;
    IF v_lines <> v_p.total_ht_centimes THEN
      RAISE EXCEPTION 'lines of purchase % add up to %, the purchase total HT is %', v_id, v_lines, v_p.total_ht_centimes
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER purchase_balanced AFTER INSERT ON public.purchase
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.purchase_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER purchase_line_balanced AFTER INSERT ON public.purchase_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.purchase_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER purchase_plan_item_balanced AFTER INSERT ON public.purchase_plan_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.purchase_balanced();
--> statement-breakpoint

ALTER TABLE public.purchase ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase_line FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase_plan_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase_plan_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.purchase, public.purchase_line, public.purchase_plan_item FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.purchase, public.purchase_line, public.purchase_plan_item TO belgobeton_app;
--> statement-breakpoint
-- Owner and support read (support through support_read). Office inserts and cannot read back; partner and plant have
-- no policy on the base tables (they read purchase_line_ops).
CREATE POLICY purchase_read ON public.purchase FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY purchase_insert ON public.purchase FOR INSERT TO belgobeton_app
  WITH CHECK (
    created_by = ctx.user_id() AND (
      (ctx.role() IN ('owner', 'office') AND reverses_id IS NULL AND reason IS NULL)
      OR (ctx.role() = 'owner' AND reverses_id IS NOT NULL AND reason IS NOT NULL)
    )
  );
--> statement-breakpoint
CREATE POLICY purchase_line_read ON public.purchase_line FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY purchase_line_insert ON public.purchase_line FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'office') AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY purchase_plan_item_read ON public.purchase_plan_item FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY purchase_plan_item_insert ON public.purchase_plan_item FOR INSERT TO belgobeton_app
  WITH CHECK (
    created_by = ctx.user_id() AND (
      (ctx.role() IN ('owner', 'office') AND reverses_id IS NULL)
      OR (ctx.role() = 'owner' AND reverses_id IS NOT NULL)
    )
  );
--> statement-breakpoint
SELECT public.grant_support_read('public.purchase');
--> statement-breakpoint
SELECT public.grant_support_read('public.purchase_line');
--> statement-breakpoint
SELECT public.grant_support_read('public.purchase_plan_item');
--> statement-breakpoint
SELECT audit.attach('public.purchase');
--> statement-breakpoint
SELECT audit.attach('public.purchase_line');
--> statement-breakpoint
SELECT audit.attach('public.purchase_plan_item');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item')
$$;
--> statement-breakpoint

-- What the plant and the partner see of a purchase: the stocked lines to receive, in quantities only (no price, total,
-- invoice number, due date or plan). Services (transport, fuel) are not listed: nothing to put in the stock.
CREATE VIEW public.purchase_line_ops AS
  SELECT p.id AS purchase_id, p.code, s.code AS supplier_code, p.order_date, l.id AS line_id, l.seq,
         c.id AS component_id, c.name_fr, c.name_ar, u.label AS unit_label, l.qty_milli,
         EXISTS (SELECT 1 FROM public.purchase r WHERE r.reverses_id = p.id) AS is_reversed
    FROM public.purchase p
    JOIN public.supplier s ON s.id = p.supplier_id
    JOIN public.purchase_line l ON l.purchase_id = p.id
    JOIN public.component c ON c.id = l.component_id
    JOIN public.purchase_unit u ON u.id = l.purchase_unit_id
   WHERE p.reverses_id IS NULL AND ctx.role() IN ('owner', 'support', 'partner', 'plant');
--> statement-breakpoint
REVOKE ALL ON public.purchase_line_ops FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.purchase_line_ops TO belgobeton_app;
--> statement-breakpoint
ALTER VIEW public.purchase_line_ops SET (security_barrier = true);
