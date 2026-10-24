-- ledger L11 (DECISIONS 81): allocations. An instrument covers plan items (one instrument several items, several
-- instruments one item). Insert-only: undoing an allocation is a negated row (reverses_id, mandatory reason), never an
-- edit or a delete. The invariants live here: the sum allocated from an instrument never exceeds its amount, the sum
-- allocated to an item never exceeds its amount (advisory locks make this hold under concurrency).
-- Office cannot read items or instruments, so it covers an order by its code through allocate_to_order(), which fills the
-- open items oldest first inside the database and returns only a count: no amount leaves it.

CREATE TABLE public.allocation (
  id                   uuid PRIMARY KEY,
  instrument_id        uuid   NOT NULL REFERENCES public.payment_instrument (id),
  payment_plan_item_id uuid   NOT NULL REFERENCES public.payment_plan_item (id),
  amount_centimes      bigint NOT NULL CHECK (amount_centimes <> 0),
  reverses_id          uuid   UNIQUE REFERENCES public.allocation (id),
  reason               text   CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by           uuid   NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((reverses_id IS NULL) = (amount_centimes > 0)),
  CHECK (reverses_id IS NULL OR reason IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX allocation_instrument_idx ON public.allocation (instrument_id);
--> statement-breakpoint
CREATE INDEX allocation_item_idx ON public.allocation (payment_plan_item_id);
--> statement-breakpoint
ALTER TABLE public.allocation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.allocation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.allocation FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.allocation TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY allocation_definer_read ON public.allocation FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY allocation_definer_insert ON public.allocation FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY allocation_read ON public.allocation FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY allocation_insert ON public.allocation FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.allocation');
--> statement-breakpoint
SELECT audit.attach('public.allocation');
--> statement-breakpoint

CREATE FUNCTION public.allocation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i     public.payment_instrument%ROWTYPE;
  v_item  public.payment_plan_item%ROWTYPE;
  v_orig  public.allocation%ROWTYPE;
  v_state text;
  v_sum   bigint;
BEGIN
  -- Instrument first, then item, everywhere: no lock cycle.
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:' || NEW.instrument_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || NEW.payment_plan_item_id::text, 0));
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = NEW.instrument_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation: unknown instrument' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_item FROM public.payment_plan_item WHERE id = NEW.payment_plan_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation: unknown item' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.allocation WHERE id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'allocation: unknown allocation to reverse' USING ERRCODE = 'check_violation';
    END IF;
    IF v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'allocation: a reversal cannot be reversed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.instrument_id <> v_orig.instrument_id OR NEW.payment_plan_item_id <> v_orig.payment_plan_item_id
       OR NEW.amount_centimes <> -v_orig.amount_centimes THEN
      RAISE EXCEPTION 'allocation: a reversal negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF v_item.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = v_item.order_id) THEN
    RAISE EXCEPTION 'allocation: the item belongs to a cancelled order' USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.direction <> v_i.direction THEN
    RAISE EXCEPTION 'allocation: the instrument and the item go in different directions' USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.direction = 'in' AND v_i.client_id IS DISTINCT FROM (SELECT o.client_id FROM public.sales_order o WHERE o.id = v_item.order_id) THEN
    RAISE EXCEPTION 'allocation: the instrument belongs to another party' USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.event INTO v_state FROM public.instrument_event e WHERE e.instrument_id = v_i.id ORDER BY e.seq DESC LIMIT 1;
  IF v_state IN ('cancelled', 'bounced', 'disputed', 'regularized') THEN
    RAISE EXCEPTION 'allocation: the instrument can no longer cover anything' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(a.amount_centimes), 0) INTO v_sum FROM public.allocation a WHERE a.instrument_id = v_i.id;
  IF v_sum + NEW.amount_centimes > v_i.amount_centimes THEN
    RAISE EXCEPTION 'allocation: more than the instrument' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(a.amount_centimes), 0) INTO v_sum FROM public.allocation a WHERE a.payment_plan_item_id = v_item.id;
  IF v_sum + NEW.amount_centimes > v_item.amount_centimes THEN
    RAISE EXCEPTION 'allocation: more than the item' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER allocation_guard BEFORE INSERT ON public.allocation
  FOR EACH ROW EXECUTE FUNCTION public.allocation_guard();
--> statement-breakpoint

-- Covers an order (by its code) with an instrument the caller entered, oldest open item first. Returns how many items it
-- touched and nothing else; 0 for anything that does not fit (unknown code, another client's order, nothing open).
CREATE FUNCTION public.allocate_to_order(p_instrument uuid, p_order_code text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text := ctx.role();
  v_i     public.payment_instrument%ROWTYPE;
  v_order public.sales_order%ROWTYPE;
  v_item  public.payment_plan_item%ROWTYPE;
  v_left  bigint;
  v_open  bigint;
  v_take  bigint;
  v_n     integer := 0;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'allocate_to_order: role % may not allocate', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = p_instrument;
  IF NOT FOUND OR v_i.direction <> 'in' OR (v_role = 'office' AND v_i.created_by <> ctx.user_id()) THEN
    RETURN 0;
  END IF;
  SELECT * INTO v_order FROM public.sales_order o
   WHERE o.code = p_order_code AND o.reverses_id IS NULL AND o.client_id = v_i.client_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = v_order.id) THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:' || v_i.id::text, 0));
  SELECT v_i.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_left
    FROM public.allocation a WHERE a.instrument_id = v_i.id;
  FOR v_item IN SELECT * FROM public.payment_plan_item i WHERE i.order_id = v_order.id AND i.reverses_id IS NULL ORDER BY i.seq LOOP
    EXIT WHEN v_left <= 0;
    PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || v_item.id::text, 0));
    SELECT v_item.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_open
      FROM public.allocation a WHERE a.payment_plan_item_id = v_item.id;
    CONTINUE WHEN v_open <= 0;
    v_take := least(v_open, v_left);
    INSERT INTO public.allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by)
    VALUES (gen_random_uuid(), v_i.id, v_item.id, v_take, ctx.user_id());
    v_left := v_left - v_take;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.allocate_to_order(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.allocate_to_order(uuid, text) TO belgobeton_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation')
$$;
