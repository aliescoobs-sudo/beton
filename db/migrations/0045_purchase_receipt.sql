-- ledger L21 + operations O5 (AC-OPS-03): a purchase is received once; the receipt puts the stocked lines into the stock
-- (quantity in the purchase unit x its factor to the base unit, e.g. 30 t of cement = +30 000 000 g), and the owner or
-- partner sets a low-stock threshold per component. Quantities only: no price, total or payment anywhere on these tables.
-- The receipt is written by one reviewed SECURITY DEFINER function so that the plant (which reads no purchase) can record
-- it; the database checks the movements against the purchase lines, line by line and for completeness at commit.

CREATE TABLE public.purchase_receipt (
  id            uuid PRIMARY KEY,
  purchase_id   uuid NOT NULL UNIQUE REFERENCES public.purchase (id),
  received_date date NOT NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.stock_threshold (
  id           uuid PRIMARY KEY,
  component_id uuid   NOT NULL REFERENCES public.component (id),
  -- Below this many base units (g, mL, L) the component is "low". The latest row of a component is the one in force.
  low_qty_base bigint NOT NULL CHECK (low_qty_base > 0),
  created_by   uuid   NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX stock_threshold_component_idx ON public.stock_threshold (component_id, created_at);
--> statement-breakpoint
ALTER TABLE public.purchase_receipt ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase_receipt FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stock_threshold ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stock_threshold FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.purchase_receipt, public.stock_threshold FROM PUBLIC;
--> statement-breakpoint
-- The receipt has no INSERT grant for the application: only record_receipt() writes it.
GRANT SELECT ON public.purchase_receipt TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.stock_threshold TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY purchase_receipt_definer_read ON public.purchase_receipt FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY purchase_receipt_definer_insert ON public.purchase_receipt FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY stock_movement_definer_insert ON public.stock_movement FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY purchase_receipt_read ON public.purchase_receipt FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY stock_threshold_read ON public.stock_threshold FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY stock_threshold_insert ON public.stock_threshold FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.purchase_receipt');
--> statement-breakpoint
SELECT public.grant_support_read('public.stock_threshold');
--> statement-breakpoint
SELECT audit.attach('public.purchase_receipt');
--> statement-breakpoint
SELECT audit.attach('public.stock_threshold');
--> statement-breakpoint

-- A stock movement for a receipt is the quantity of the purchase lines of that component (also the guard for every other
-- source, unchanged from O3).
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
    SELECT coalesce(sum(public.scale_qty(l.qty_milli, u.factor_to_base, 1000)), 0) INTO v_qty
      FROM public.purchase_line l JOIN public.purchase_unit u ON u.id = l.purchase_unit_id
     WHERE l.purchase_id = v_r.purchase_id AND l.component_id = NEW.component_id;
    IF v_qty <= 0 OR NEW.qty_base <> v_qty OR NEW.movement_date <> v_r.received_date THEN
      RAISE EXCEPTION 'stock_movement: not the quantity of the purchase lines for this receipt' USING ERRCODE = 'check_violation';
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

-- A receipt without all its movements is refused at commit: one per stocked component of the purchase.
CREATE FUNCTION public.receipt_has_movements() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_expected integer;
  v_found    integer;
BEGIN
  SELECT count(*) INTO v_expected FROM (
    SELECT l.component_id FROM public.purchase_line l JOIN public.purchase_unit u ON u.id = l.purchase_unit_id
     WHERE l.purchase_id = NEW.purchase_id AND l.component_id IS NOT NULL
     GROUP BY l.component_id HAVING sum(public.scale_qty(l.qty_milli, u.factor_to_base, 1000)) > 0) x;
  SELECT count(*) INTO v_found FROM public.stock_movement m WHERE m.source = 'receipt' AND m.source_id = NEW.id;
  IF v_expected = 0 OR v_found <> v_expected THEN
    RAISE EXCEPTION 'receipt of purchase %: the stock movements are missing or too many', NEW.purchase_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER receipt_has_movements AFTER INSERT ON public.purchase_receipt
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.receipt_has_movements();
--> statement-breakpoint

-- Records the receipt of a purchase and its stock movements, once (UNIQUE purchase_id). Owner, partner and plant. Returns
-- the receipt id and nothing else: the plant learns no price or total.
CREATE FUNCTION public.record_receipt(p_purchase uuid, p_date date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_p  public.purchase%ROWTYPE;
  v_id uuid := gen_random_uuid();
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
  INSERT INTO public.purchase_receipt (id, purchase_id, received_date, created_by)
  VALUES (v_id, p_purchase, p_date, ctx.user_id());
  INSERT INTO public.stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by)
  SELECT gen_random_uuid(), l.component_id, p_date, sum(public.scale_qty(l.qty_milli, u.factor_to_base, 1000)), 'receipt', v_id, ctx.user_id()
    FROM public.purchase_line l JOIN public.purchase_unit u ON u.id = l.purchase_unit_id
   WHERE l.purchase_id = p_purchase AND l.component_id IS NOT NULL
   GROUP BY l.component_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_receipt(uuid, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_receipt(uuid, date) TO belgobeton_app;
