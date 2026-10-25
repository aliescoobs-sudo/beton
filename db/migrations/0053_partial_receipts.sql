-- Review of CP-OPS-1-3, point 3: several receipts per purchase until the ordered quantity is reached, each adding its stock.
-- A receipt now has its own lines (which purchase line, how much), the stock movement of a receipt is the sum of its lines per
-- component, and a receipt that takes a line past its ordered quantity is an over-receipt: only the owner records it, with a
-- confirmation, and it is flagged on the receipt. Quantities only, no money anywhere.
-- Existing receipts (one per purchase, whole) are converted: each gets one line per stocked purchase line, for the ordered quantity.

ALTER TABLE public.purchase_receipt DROP CONSTRAINT purchase_receipt_purchase_id_key;
--> statement-breakpoint
ALTER TABLE public.purchase_receipt ADD COLUMN over_receipt boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX purchase_receipt_purchase_idx ON public.purchase_receipt (purchase_id);
--> statement-breakpoint

CREATE TABLE public.purchase_receipt_line (
  id               uuid PRIMARY KEY,
  receipt_id       uuid   NOT NULL REFERENCES public.purchase_receipt (id),
  purchase_line_id uuid   NOT NULL REFERENCES public.purchase_line (id),
  -- Thousandths of the purchase unit, like the purchase line.
  qty_milli        bigint NOT NULL CHECK (qty_milli > 0),
  UNIQUE (receipt_id, purchase_line_id)
);
--> statement-breakpoint
CREATE INDEX purchase_receipt_line_line_idx ON public.purchase_receipt_line (purchase_line_id);
--> statement-breakpoint
ALTER TABLE public.purchase_receipt_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase_receipt_line FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.purchase_receipt_line FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.purchase_receipt_line TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY purchase_receipt_line_read ON public.purchase_receipt_line FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY purchase_receipt_line_definer_read ON public.purchase_receipt_line FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY purchase_receipt_line_definer_insert ON public.purchase_receipt_line FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.purchase_receipt_line');
--> statement-breakpoint
SELECT audit.attach('public.purchase_receipt_line');
--> statement-breakpoint

-- Data steps in a migration write as the system actor: the audit trigger needs a request context.
SELECT set_config('app.user_id', '00000000-0000-7000-8000-000000000002', true),
       set_config('app.role', 'system', true),
       set_config('app.request_id', 'migration-0053', true);
--> statement-breakpoint
-- Convert what exists: one line per stocked purchase line, for the ordered quantity (the old receipt took everything).
INSERT INTO public.purchase_receipt_line (id, receipt_id, purchase_line_id, qty_milli)
SELECT gen_random_uuid(), r.id, l.id, l.qty_milli
  FROM public.purchase_receipt r JOIN public.purchase_line l ON l.purchase_id = r.purchase_id
 WHERE l.component_id IS NOT NULL;
--> statement-breakpoint

-- The movement of a receipt is the sum of its lines, per component.
CREATE OR REPLACE FUNCTION public.stock_movement_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d    public.delivery%ROWTYPE;
  v_line public.recette_line%ROWTYPE;
  v_orig public.stock_movement%ROWTYPE;
  v_r    public.purchase_receipt%ROWTYPE;
  v_qty  bigint;
BEGIN
  IF NEW.source = 'delivery' THEN
    SELECT * INTO v_d FROM public.delivery WHERE id = NEW.source_id AND reverses_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock_movement: not a live load' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_line FROM public.recette_line WHERE recette_id = v_d.recette_id AND component_id = NEW.component_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock_movement: the component is not in the recette of the load' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.qty_base <> -public.scale_qty(v_line.qty_per_m3, v_d.volume_l, 1000) OR NEW.movement_date <> v_d.load_date THEN
      RAISE EXCEPTION 'stock_movement: not the quantity of the recette for this load' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.source = 'receipt' THEN
    SELECT * INTO v_r FROM public.purchase_receipt WHERE id = NEW.source_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock_movement: not a receipt' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(public.scale_qty(rl.qty_milli, u.factor_to_base, 1000)), 0) INTO v_qty
      FROM public.purchase_receipt_line rl
      JOIN public.purchase_line l ON l.id = rl.purchase_line_id
      JOIN public.purchase_unit u ON u.id = l.purchase_unit_id
     WHERE rl.receipt_id = v_r.id AND l.component_id = NEW.component_id;
    IF v_qty <= 0 OR NEW.qty_base <> v_qty OR NEW.movement_date <> v_r.received_date THEN
      RAISE EXCEPTION 'stock_movement: not the quantity of the receipt lines for this receipt' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.source = 'reversal' THEN
    SELECT * INTO v_orig FROM public.stock_movement WHERE id = NEW.reverses_id;
    IF NOT FOUND OR v_orig.reverses_id IS NOT NULL OR v_orig.source <> 'delivery' THEN
      RAISE EXCEPTION 'stock_movement: only a load movement can be reversed, once' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.component_id <> v_orig.component_id OR NEW.qty_base <> -v_orig.qty_base THEN
      RAISE EXCEPTION 'stock_movement: a reversal negates its movement exactly' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.id = NEW.source_id AND r.reverses_id = v_orig.source_id) THEN
      RAISE EXCEPTION 'stock_movement: not the cancellation of this load' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.source = 'opening' THEN
    IF NEW.qty_base < 0 OR NEW.source_id <> NEW.component_id THEN
      RAISE EXCEPTION 'stock_movement: the opening stock is positive, one per component' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- A receipt must have its lines and one movement per stocked component of those lines, at commit.
DROP TRIGGER receipt_has_movements ON public.purchase_receipt;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.receipt_has_movements() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_expected integer;
  v_found    integer;
BEGIN
  SELECT count(DISTINCT l.component_id) INTO v_expected
    FROM public.purchase_receipt_line rl JOIN public.purchase_line l ON l.id = rl.purchase_line_id
   WHERE rl.receipt_id = NEW.id AND l.component_id IS NOT NULL;
  SELECT count(*) INTO v_found FROM public.stock_movement m WHERE m.source = 'receipt' AND m.source_id = NEW.id;
  IF v_expected = 0 OR v_found <> v_expected THEN
    RAISE EXCEPTION 'receipt of purchase %: the lines or the stock movements are missing or too many', NEW.purchase_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER receipt_has_movements AFTER INSERT ON public.purchase_receipt
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.receipt_has_movements();
--> statement-breakpoint

-- What a receipt line may be: a stocked line of the receipt's own purchase, in whole base units.
CREATE FUNCTION public.purchase_receipt_line_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_r public.purchase_receipt%ROWTYPE;
  v_l public.purchase_line%ROWTYPE;
  v_u public.purchase_unit%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM public.purchase_receipt r WHERE r.id = NEW.receipt_id;
  SELECT * INTO v_l FROM public.purchase_line l WHERE l.id = NEW.purchase_line_id;
  IF v_r.id IS NULL OR v_l.id IS NULL OR v_l.purchase_id <> v_r.purchase_id OR v_l.component_id IS NULL THEN
    RAISE EXCEPTION 'receipt line: not a stocked line of the purchase' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_u FROM public.purchase_unit u WHERE u.id = v_l.purchase_unit_id;
  IF (NEW.qty_milli * v_u.factor_to_base) % 1000 <> 0 THEN
    RAISE EXCEPTION 'receipt line: not a whole number of base units' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_receipt_line_guard BEFORE INSERT ON public.purchase_receipt_line
  FOR EACH ROW EXECUTE FUNCTION public.purchase_receipt_line_guard();
--> statement-breakpoint

-- The only writer of receipts (no INSERT grant for the application), so the over-receipt flag is set here, under an advisory lock
-- per purchase. Records a receipt of some or all of what is still expected. `p_lines` is [{"lineId": uuid, "qtyMilli": n}], or NULL for
-- everything still expected. A line past its ordered quantity needs the owner and his confirmation. Returns the receipt id.
CREATE FUNCTION public.record_receipt_lines(p_purchase uuid, p_date date, p_lines jsonb, p_confirm_excess boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_p    public.purchase%ROWTYPE;
  v_id   uuid := gen_random_uuid();
  v_over boolean := false;
  v_n    integer := 0;
  v_row  record;
  v_item jsonb;
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'plant', 'system') THEN
    RAISE EXCEPTION 'record_receipt: role % may not record a receipt', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_p FROM public.purchase p WHERE p.id = p_purchase;
  IF NOT FOUND OR v_p.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'record_receipt: unknown purchase' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase r WHERE r.reverses_id = v_p.id) THEN
    RAISE EXCEPTION 'record_receipt: the purchase is cancelled' USING ERRCODE = 'check_violation';
  END IF;
  IF p_date < v_p.order_date THEN
    RAISE EXCEPTION 'record_receipt: received before it was ordered' USING ERRCODE = 'check_violation';
  END IF;
  -- Serialize receipts of one purchase: the remaining quantity is read and used under the lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('receipt:' || p_purchase::text, 0));

  CREATE TEMPORARY TABLE _receipt_wanted (line_id uuid PRIMARY KEY, qty_milli bigint NOT NULL) ON COMMIT DROP;
  IF p_lines IS NULL THEN
    INSERT INTO pg_temp._receipt_wanted
    SELECT l.id, l.qty_milli - coalesce((SELECT sum(x.qty_milli) FROM public.purchase_receipt_line x WHERE x.purchase_line_id = l.id), 0)
      FROM public.purchase_line l
     WHERE l.purchase_id = p_purchase AND l.component_id IS NOT NULL
       AND l.qty_milli - coalesce((SELECT sum(x.qty_milli) FROM public.purchase_receipt_line x WHERE x.purchase_line_id = l.id), 0) > 0;
    IF NOT EXISTS (SELECT 1 FROM pg_temp._receipt_wanted) THEN
      RAISE EXCEPTION 'record_receipt: already received' USING ERRCODE = 'unique_violation';
    END IF;
  ELSE
    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'record_receipt: no lines' USING ERRCODE = 'check_violation';
    END IF;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      BEGIN
        INSERT INTO pg_temp._receipt_wanted VALUES ((v_item ->> 'lineId')::uuid, (v_item ->> 'qtyMilli')::bigint);
      EXCEPTION WHEN unique_violation OR invalid_text_representation OR not_null_violation OR check_violation THEN
        RAISE EXCEPTION 'record_receipt: invalid lines' USING ERRCODE = 'check_violation';
      END;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_temp._receipt_wanted w WHERE w.qty_milli <= 0) THEN
      RAISE EXCEPTION 'record_receipt: invalid lines' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOR v_row IN
    SELECT w.line_id, w.qty_milli, l.qty_milli AS ordered,
           coalesce((SELECT sum(x.qty_milli) FROM public.purchase_receipt_line x WHERE x.purchase_line_id = l.id), 0) AS before
      FROM pg_temp._receipt_wanted w LEFT JOIN public.purchase_line l ON l.id = w.line_id AND l.purchase_id = p_purchase AND l.component_id IS NOT NULL
  LOOP
    IF v_row.ordered IS NULL THEN
      RAISE EXCEPTION 'record_receipt: not a stocked line of the purchase' USING ERRCODE = 'check_violation';
    END IF;
    IF v_row.before + v_row.qty_milli > v_row.ordered THEN
      v_over := true;
    END IF;
  END LOOP;
  IF v_over AND (NOT coalesce(p_confirm_excess, false) OR ctx.role() NOT IN ('owner', 'system')) THEN
    RAISE EXCEPTION 'record_receipt: more than ordered needs the owner''s confirmation' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.purchase_receipt (id, purchase_id, received_date, over_receipt, created_by)
  VALUES (v_id, p_purchase, p_date, v_over, ctx.user_id());
  INSERT INTO public.purchase_receipt_line (id, receipt_id, purchase_line_id, qty_milli)
  SELECT gen_random_uuid(), v_id, w.line_id, w.qty_milli FROM pg_temp._receipt_wanted w;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by)
  SELECT gen_random_uuid(), l.component_id, p_date, sum(public.scale_qty(w.qty_milli, u.factor_to_base, 1000)), 'receipt', v_id, ctx.user_id()
    FROM pg_temp._receipt_wanted w
    JOIN public.purchase_line l ON l.id = w.line_id
    JOIN public.purchase_unit u ON u.id = l.purchase_unit_id
   GROUP BY l.component_id;
  DROP TABLE pg_temp._receipt_wanted;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_receipt_lines(uuid, date, jsonb, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_receipt_lines(uuid, date, jsonb, boolean) TO belgobeton_app;
--> statement-breakpoint

-- The old entry point keeps its meaning: receive everything still expected.
CREATE OR REPLACE FUNCTION public.record_receipt(p_purchase uuid, p_date date) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.record_receipt_lines(p_purchase, p_date, NULL, false)
$$;
