-- R1 (CP-PROD-PLAN, REQUIREMENTS-V1 §1, §2, §6; DECISIONS 124, 125, 133): two plants, one office.
-- Structure only: the plants themselves are created by the owner (or the app_admin) in the application, never by a
-- migration. Additive: nothing existing is dropped or narrowed; migrations 0078 to 0199 belong to this build.
--
-- How a row learns its plant (the "plants" module flag is simply whether plants exist):
--   * no active plant yet: plant_id may stay empty (the pilot data, a database not yet set up);
--   * exactly one active plant: the row takes it;
--   * two or more: the row must name its plant (explicitly, from its parent, or from the request's plant context
--     `app.plant_id`), else the insert is refused with a check violation. This is a database rule, not a convention.

CREATE TABLE public.plant (
  id         uuid PRIMARY KEY,
  code       text NOT NULL CHECK (code ~ '^[A-Z]{2,8}$'),
  name       text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX plant_code_unique ON public.plant (code);
--> statement-breakpoint
CREATE UNIQUE INDEX plant_name_unique ON public.plant (lower(name));
--> statement-breakpoint
ALTER TABLE public.plant ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.plant FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.plant FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.plant TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT ON public.plant TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY plant_read ON public.plant FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'support', 'system'));
--> statement-breakpoint
CREATE POLICY plant_insert ON public.plant FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY plant_update ON public.plant FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner')) WITH CHECK (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
CREATE POLICY plant_definer_read ON public.plant FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
SELECT audit.attach('public.plant');
--> statement-breakpoint

-- The plant of the request (a plant manager's own plant, or the plant a person picked on a screen).
CREATE FUNCTION ctx.plant_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.plant_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.plant_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.plant_id() TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint

-- Machines: kind, plant, why it is stopped, and how an external truck is paid (the rate is money: finance's).
ALTER TABLE public.truck
  ADD COLUMN plant_id uuid REFERENCES public.plant(id),
  ADD COLUMN kind text NOT NULL DEFAULT 'mixer' CHECK (kind IN ('mixer', 'pump', 'external')),
  ADD COLUMN stopped_decision text CHECK (stopped_decision IN ('repair_use', 'repair_sell', 'sell_as_is')),
  ADD COLUMN pay_basis text CHECK (pay_basis IN ('per_trip', 'per_m3', 'per_day')),
  ADD CONSTRAINT truck_pay_basis_external CHECK (pay_basis IS NULL OR kind = 'external'),
  ADD CONSTRAINT truck_pump_no_plant CHECK (kind <> 'pump' OR plant_id IS NULL);
--> statement-breakpoint
-- The capacity limits of a pump truck are not those of a mixer (a pump has no m³ capacity worth planning with).
ALTER TABLE public.truck DROP CONSTRAINT truck_code_check;
--> statement-breakpoint
ALTER TABLE public.truck ADD CONSTRAINT truck_code_check CHECK (code ~ '^[TPX][0-9]{1,3}$');
--> statement-breakpoint
ALTER TABLE public.truck ADD CONSTRAINT truck_code_kind CHECK (
  (kind = 'mixer' AND code ~ '^T') OR (kind = 'pump' AND code ~ '^P') OR (kind = 'external' AND code ~ '^X'));
--> statement-breakpoint
ALTER TABLE public.component
  ADD COLUMN lead_time_days integer CHECK (lead_time_days BETWEEN 0 AND 60);
--> statement-breakpoint

ALTER TABLE public.sales_order       ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
ALTER TABLE public.delivery          ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
ALTER TABLE public.trip_plan         ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
ALTER TABLE public.stock_movement    ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
ALTER TABLE public.stock_threshold   ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
ALTER TABLE public.purchase          ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
ALTER TABLE public.purchase_receipt  ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
ALTER TABLE public.fuel_fill         ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
ALTER TABLE public.fuel_purchase     ADD COLUMN plant_id uuid REFERENCES public.plant(id);
--> statement-breakpoint
CREATE INDEX sales_order_plant_idx      ON public.sales_order (plant_id, delivery_date);
--> statement-breakpoint
CREATE INDEX delivery_plant_idx         ON public.delivery (plant_id, load_date);
--> statement-breakpoint
CREATE INDEX trip_plan_plant_idx        ON public.trip_plan (plant_id, trip_date);
--> statement-breakpoint
CREATE INDEX stock_movement_plant_idx   ON public.stock_movement (plant_id, component_id, movement_date);
--> statement-breakpoint
CREATE INDEX stock_threshold_plant_idx  ON public.stock_threshold (plant_id, component_id);
--> statement-breakpoint
CREATE INDEX purchase_plant_idx         ON public.purchase (plant_id, order_date);
--> statement-breakpoint
CREATE INDEX truck_plant_idx            ON public.truck (plant_id);
--> statement-breakpoint

-- The one rule that gives a row its plant. Runs first (name sorts before the other BEFORE INSERT triggers).
CREATE FUNCTION public.plant_fill() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_parent uuid;      -- the plant of the parent document, when there is one
  v_truck  uuid;
  v_n      integer;
  v_only   uuid;
BEGIN
  IF TG_TABLE_NAME IN ('delivery', 'trip_plan') THEN
    SELECT o.plant_id INTO v_parent FROM public.sales_order o WHERE o.id = NEW.order_id;
    SELECT t.plant_id INTO v_truck FROM public.truck t WHERE t.id = NEW.truck_id;
  ELSIF TG_TABLE_NAME = 'purchase_receipt' THEN
    SELECT p.plant_id INTO v_parent FROM public.purchase p WHERE p.id = NEW.purchase_id;
  ELSIF TG_TABLE_NAME = 'stock_movement' THEN
    IF NEW.source = 'delivery' THEN
      SELECT d.plant_id INTO v_parent FROM public.delivery d WHERE d.id = NEW.source_id;
    ELSIF NEW.source = 'receipt' THEN
      SELECT r.plant_id INTO v_parent FROM public.purchase_receipt r WHERE r.id = NEW.source_id;
    ELSIF NEW.source = 'reversal' THEN
      SELECT m.plant_id INTO v_parent FROM public.stock_movement m WHERE m.id = NEW.reverses_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'fuel_fill' THEN
    SELECT t.plant_id INTO v_parent FROM public.truck t WHERE t.id = NEW.truck_id;
  END IF;

  IF NEW.plant_id IS NOT NULL AND v_parent IS NOT NULL AND NEW.plant_id <> v_parent THEN
    RAISE EXCEPTION '%: the plant is not the plant of its document', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.plant_id IS NULL THEN NEW.plant_id := v_parent; END IF;
  IF NEW.plant_id IS NULL THEN NEW.plant_id := ctx.plant_id(); END IF;

  IF NEW.plant_id IS NULL THEN
    SELECT count(*), (array_agg(p.id))[1] INTO v_n, v_only FROM public.plant p WHERE p.status = 'active';
    IF v_n = 1 THEN
      NEW.plant_id := v_only;
    ELSIF v_n >= 2 THEN
      RAISE EXCEPTION '%: the plant is required', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.plant_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.plant p WHERE p.id = NEW.plant_id AND p.status = 'active') THEN
      RAISE EXCEPTION '%: the plant is archived or unknown', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A mixer belongs to one plant; it does not load or get planned at the other. Pumps and external trucks have none.
  IF v_truck IS NOT NULL AND NEW.plant_id IS NOT NULL AND v_truck <> NEW.plant_id THEN
    RAISE EXCEPTION '%: the truck belongs to another plant', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.plant_fill() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_order', 'delivery', 'trip_plan', 'stock_movement', 'stock_threshold', 'purchase',
                           'purchase_receipt', 'fuel_fill', 'fuel_purchase'] LOOP
    EXECUTE format('CREATE TRIGGER a_plant_fill BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.plant_fill()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- A mixer with a plant needs it: the plant is mandatory for a new truck once two plants exist.
CREATE FUNCTION public.truck_plant_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  IF NEW.kind = 'mixer' AND NEW.plant_id IS NULL AND TG_OP = 'INSERT' THEN
    SELECT count(*) INTO v_n FROM public.plant p WHERE p.status = 'active';
    IF v_n >= 2 THEN
      RAISE EXCEPTION 'truck: a mixer needs its plant' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.plant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.plant p WHERE p.id = NEW.plant_id AND p.status = 'active')
     AND (TG_OP = 'INSERT' OR NEW.plant_id IS DISTINCT FROM OLD.plant_id) THEN
    RAISE EXCEPTION 'truck: the plant is archived or unknown' USING ERRCODE = 'check_violation';
  END IF;
  -- Kind and plant are fixed once a truck has history: a move between plants is a decision, not a typo.
  IF TG_OP = 'UPDATE' AND (NEW.kind <> OLD.kind
      OR (OLD.plant_id IS NOT NULL AND NEW.plant_id IS DISTINCT FROM OLD.plant_id
          AND EXISTS (SELECT 1 FROM public.delivery d WHERE d.truck_id = NEW.id))) THEN
    RAISE EXCEPTION 'truck: kind and plant cannot change once it has loads' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.truck_plant_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER truck_plant_guard BEFORE INSERT OR UPDATE ON public.truck
  FOR EACH ROW EXECUTE FUNCTION public.truck_plant_guard();
--> statement-breakpoint

-- Opening stock is one per component and per plant: its source id is the component (no plant yet) or the plant.
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
    IF NEW.qty_base < 0 OR NOT (NEW.source_id = NEW.component_id OR (NEW.plant_id IS NOT NULL AND NEW.source_id = NEW.plant_id)) THEN
      RAISE EXCEPTION 'stock_movement: the opening stock is positive, one per component and plant' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.source = 'count_adjustment' THEN
    IF NEW.reason IS NULL OR length(NEW.reason) < 3 THEN
      RAISE EXCEPTION 'stock_movement: a stock count correction needs a reason' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Receipt in two steps (DECISIONS 133): the plant confirms what arrived, then the office confirms with the supplier and
-- enters the details; only then does stock go up. Each confirmation of the plant covers one receipt.
CREATE TABLE public.receipt_plant_confirmation (
  id           uuid PRIMARY KEY,
  purchase_id  uuid NOT NULL REFERENCES public.purchase(id),
  plant_id     uuid REFERENCES public.plant(id),
  note         text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 300)),
  confirmed_by uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  receipt_id   uuid UNIQUE REFERENCES public.purchase_receipt(id)
);
--> statement-breakpoint
CREATE INDEX receipt_plant_confirmation_open_idx ON public.receipt_plant_confirmation (purchase_id) WHERE receipt_id IS NULL;
--> statement-breakpoint
ALTER TABLE public.receipt_plant_confirmation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.receipt_plant_confirmation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.receipt_plant_confirmation FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.receipt_plant_confirmation TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY receipt_plant_confirmation_read ON public.receipt_plant_confirmation FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant', 'support'));
--> statement-breakpoint
CREATE POLICY receipt_plant_confirmation_definer ON public.receipt_plant_confirmation FOR ALL TO belgobeton_migrator
  USING (true) WITH CHECK (true);
--> statement-breakpoint
SELECT audit.attach('public.receipt_plant_confirmation');
--> statement-breakpoint

CREATE FUNCTION public.confirm_receipt_at_plant(p_purchase uuid, p_note text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_p  public.purchase%ROWTYPE;
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'plant', 'system') THEN
    RAISE EXCEPTION 'confirm_receipt_at_plant: role % may not confirm', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_p FROM public.purchase p WHERE p.id = p_purchase;
  IF NOT FOUND OR v_p.reverses_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.purchase r WHERE r.reverses_id = v_p.id) THEN
    RAISE EXCEPTION 'confirm_receipt_at_plant: unknown or cancelled purchase' USING ERRCODE = 'check_violation';
  END IF;
  -- A plant manager confirms receipts of his own plant only (the request's plant, when it has one).
  IF ctx.plant_id() IS NOT NULL AND v_p.plant_id IS NOT NULL AND ctx.plant_id() <> v_p.plant_id THEN
    RAISE EXCEPTION 'confirm_receipt_at_plant: not your plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One open confirmation per purchase at a time: the office must use it before the plant confirms the next arrival.
  IF EXISTS (SELECT 1 FROM public.receipt_plant_confirmation c WHERE c.purchase_id = p_purchase AND c.receipt_id IS NULL) THEN
    RAISE EXCEPTION 'confirm_receipt_at_plant: already confirmed, waiting for the office' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO public.receipt_plant_confirmation (id, purchase_id, plant_id, note, confirmed_by)
  VALUES (v_id, p_purchase, v_p.plant_id, nullif(btrim(p_note), ''), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.confirm_receipt_at_plant(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.confirm_receipt_at_plant(uuid, text) TO belgobeton_app, belgobeton_system;
--> statement-breakpoint

-- The existing function keeps its body as the core and is no longer callable by the application; the wrapper below
-- (same signature) adds the plant rule: once plants exist, a receipt needs the plant's confirmation, which it consumes,
-- and the plant role cannot do the office's step.
ALTER FUNCTION public.record_receipt_lines(uuid, date, jsonb, boolean) RENAME TO record_receipt_lines_core;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_receipt_lines_core(uuid, date, jsonb, boolean) FROM PUBLIC, belgobeton_app, belgobeton_system, belgobeton_seed;
--> statement-breakpoint
CREATE FUNCTION public.record_receipt_lines(p_purchase uuid, p_date date, p_lines jsonb, p_confirm_excess boolean)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id   uuid;
  v_conf uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.plant p WHERE p.status = 'active') THEN
    IF ctx.role() = 'plant' THEN
      RAISE EXCEPTION 'record_receipt: the plant confirms the arrival; the office records the receipt'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT c.id INTO v_conf FROM public.receipt_plant_confirmation c
     WHERE c.purchase_id = p_purchase AND c.receipt_id IS NULL ORDER BY c.confirmed_at LIMIT 1 FOR UPDATE;
    IF v_conf IS NULL THEN
      RAISE EXCEPTION 'record_receipt: the plant has not confirmed this arrival' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_id := public.record_receipt_lines_core(p_purchase, p_date, p_lines, p_confirm_excess);
  IF v_conf IS NOT NULL THEN
    UPDATE public.receipt_plant_confirmation SET receipt_id = v_id WHERE id = v_conf;
  END IF;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_receipt_lines(uuid, date, jsonb, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_receipt_lines(uuid, date, jsonb, boolean) TO belgobeton_app;
