-- Review of CP-OPS-1-3, point 7: the owner corrects the stock after a physical count. A correction is a movement (the stock is
-- the sum of its movements, nothing is edited): `count_adjustment`, signed, with a mandatory reason, audited. Only the owner
-- writes it (policy); the database refuses one without a reason and one for a component that does not exist.
CREATE POLICY stock_movement_insert_count ON public.stock_movement FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id() AND source = 'count_adjustment');
--> statement-breakpoint
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
  ELSIF NEW.source = 'count_adjustment' THEN
    IF NEW.reason IS NULL OR length(NEW.reason) < 3 THEN
      RAISE EXCEPTION 'stock_movement: a stock count correction needs a reason' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
