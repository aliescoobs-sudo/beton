-- ledger L22 (AC-LED-16): a supplier payment is an outgoing instrument allocated to the payment-plan items of a purchase.
-- The allocation table gains a second target, `purchase_plan_item_id`, exactly one of the two being set. Same invariants as
-- for orders (never more than the instrument, never more than the item, advisory locks, a reversal is a negated row), and
-- the instrument must go out, belong to the supplier of the purchase and the purchase must be live.
-- Office cannot read purchases, so it covers a purchase by its code through allocate_to_purchase(), which fills the open items
-- oldest first and returns only a count (the twin of allocate_to_order).

ALTER TABLE public.allocation ALTER COLUMN payment_plan_item_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.allocation ADD COLUMN purchase_plan_item_id uuid REFERENCES public.purchase_plan_item (id);
--> statement-breakpoint
ALTER TABLE public.allocation ADD CONSTRAINT allocation_one_item
  CHECK ((payment_plan_item_id IS NULL) <> (purchase_plan_item_id IS NULL));
--> statement-breakpoint
CREATE INDEX allocation_purchase_item_idx ON public.allocation (purchase_plan_item_id);
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

-- Covers a purchase (by its code) with an outgoing instrument the caller entered, oldest open item first. Returns how many
-- items it touched and nothing else; 0 for anything that does not fit.
CREATE FUNCTION public.allocate_to_purchase(p_instrument uuid, p_purchase_code text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role     text := ctx.role();
  v_i        public.payment_instrument%ROWTYPE;
  v_purchase public.purchase%ROWTYPE;
  v_item     public.purchase_plan_item%ROWTYPE;
  v_left     bigint;
  v_open     bigint;
  v_take     bigint;
  v_n        integer := 0;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'allocate_to_purchase: role % may not allocate', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = p_instrument;
  IF NOT FOUND OR v_i.direction <> 'out' OR (v_role = 'office' AND v_i.created_by <> ctx.user_id()) THEN
    RETURN 0;
  END IF;
  SELECT * INTO v_purchase FROM public.purchase p
   WHERE p.code = p_purchase_code AND p.reverses_id IS NULL AND p.supplier_id = v_i.supplier_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.purchase r WHERE r.reverses_id = v_purchase.id) THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:' || v_i.id::text, 0));
  SELECT v_i.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_left
    FROM public.allocation a WHERE a.instrument_id = v_i.id;
  FOR v_item IN SELECT * FROM public.purchase_plan_item i WHERE i.purchase_id = v_purchase.id AND i.reverses_id IS NULL ORDER BY i.seq LOOP
    EXIT WHEN v_left <= 0;
    PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || v_item.id::text, 0));
    SELECT v_item.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_open
      FROM public.allocation a WHERE a.purchase_plan_item_id = v_item.id;
    CONTINUE WHEN v_open <= 0;
    v_take := least(v_open, v_left);
    INSERT INTO public.allocation (id, instrument_id, purchase_plan_item_id, amount_centimes, created_by)
    VALUES (gen_random_uuid(), v_i.id, v_item.id, v_take, ctx.user_id());
    v_left := v_left - v_take;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.allocate_to_purchase(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.allocate_to_purchase(uuid, text) TO belgobeton_app;
