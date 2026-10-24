-- operations O3 (SPEC-operations AC-OPS-02, 04): the stock of every component is the sum of its movements. Insert-only: a
-- cancelled load writes reversing movements. Quantities only (integer base units: g, mL, L), no money.
-- A load's movements are the recette in force times the volume, one rounding per line (the same rule as
-- operations/domain/consumption.ts, mirrored by public.scale_qty and compared by a test). The service computes them; the
-- database checks them line by line and checks, at commit, that none is missing, so neither side can drift alone.
CREATE TABLE public.stock_movement (
  id            uuid PRIMARY KEY,
  component_id  uuid   NOT NULL REFERENCES public.component (id),
  movement_date date   NOT NULL,
  -- Signed: a receipt or the opening stock is positive, a load negative.
  qty_base      bigint NOT NULL CHECK (qty_base <> 0),
  source        text   NOT NULL CHECK (source IN ('delivery', 'receipt', 'count_adjustment', 'opening', 'reversal')),
  source_id     uuid   NOT NULL,
  reverses_id   uuid   UNIQUE REFERENCES public.stock_movement (id),
  reason        text   CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by    uuid   NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id, component_id),
  CHECK ((reverses_id IS NULL) = (source <> 'reversal')),
  CHECK (reverses_id IS NULL OR reason IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX stock_movement_component_idx ON public.stock_movement (component_id, movement_date);
--> statement-breakpoint
ALTER TABLE public.stock_movement ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stock_movement FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.stock_movement FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.stock_movement TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY stock_movement_definer_read ON public.stock_movement FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY recette_line_definer_read ON public.recette_line FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
-- Stock is the plant's, the owner's and the partner's (and support reads); office does not read it.
CREATE POLICY stock_movement_read ON public.stock_movement FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY stock_movement_insert_delivery ON public.stock_movement FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND created_by = ctx.user_id() AND source = 'delivery');
--> statement-breakpoint
CREATE POLICY stock_movement_insert_managed ON public.stock_movement FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND created_by = ctx.user_id() AND source IN ('opening', 'reversal'));
--> statement-breakpoint
SELECT public.grant_support_read('public.stock_movement');
--> statement-breakpoint
SELECT audit.attach('public.stock_movement');
--> statement-breakpoint

-- num/den of a quantity rounded once, half away from zero: the SQL twin of scaleQty() in src/lib/quantity.ts.
CREATE FUNCTION public.scale_qty(p_qty bigint, p_num bigint, p_den bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_qty * p_num >= 0 THEN (2 * p_qty * p_num + p_den) / (2 * p_den)
              ELSE -((2 * (-p_qty * p_num) + p_den) / (2 * p_den)) END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.scale_qty(bigint, bigint, bigint) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.stock_movement_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d    public.delivery%ROWTYPE;
  v_line public.recette_line%ROWTYPE;
  v_orig public.stock_movement%ROWTYPE;
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
CREATE TRIGGER stock_movement_guard BEFORE INSERT ON public.stock_movement
  FOR EACH ROW EXECUTE FUNCTION public.stock_movement_guard();
--> statement-breakpoint

-- A load without its movements is refused at commit: every line of its recette that rounds to something has one.
CREATE FUNCTION public.delivery_has_movements() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_expected integer;
  v_found    integer;
  v_orig     public.delivery%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NULL THEN
    SELECT count(*) INTO v_expected FROM public.recette_line l
     WHERE l.recette_id = NEW.recette_id AND public.scale_qty(l.qty_per_m3, NEW.volume_l, 1000) <> 0;
    SELECT count(*) INTO v_found FROM public.stock_movement m WHERE m.source = 'delivery' AND m.source_id = NEW.id;
  ELSE
    SELECT * INTO v_orig FROM public.delivery WHERE id = NEW.reverses_id;
    SELECT count(*) INTO v_expected FROM public.stock_movement m WHERE m.source = 'delivery' AND m.source_id = v_orig.id;
    SELECT count(*) INTO v_found FROM public.stock_movement m WHERE m.source = 'reversal' AND m.source_id = NEW.id;
  END IF;
  IF v_found <> v_expected THEN
    RAISE EXCEPTION 'delivery %: the stock movements of the load are missing or too many', NEW.bl_no USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER delivery_has_movements AFTER INSERT ON public.delivery
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.delivery_has_movements();
