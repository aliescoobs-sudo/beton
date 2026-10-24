-- operations O2 (SPEC-operations AC-OPS-01, 04, 10; DECISIONS 81 does not touch these tables: quantities only, no money).
-- A delivery is one truck load for an order, with its delivery note number (BL-YYYY-nnnnn). Insert-only: cancelling a load is
-- a reversing row (exact negation, owner or partner, with a reason); the signed-BL return is its own insert-only row, unique
-- per delivery, so a second recording (office after plant, or two at once) is a unique violation (A11).
CREATE TABLE public.delivery (
  id          uuid PRIMARY KEY,
  bl_no       text NOT NULL UNIQUE CHECK (bl_no ~ '^BL-[0-9]{4}-[0-9]{5,}$'),
  order_id    uuid NOT NULL REFERENCES public.sales_order (id),
  truck_id    uuid NOT NULL REFERENCES public.truck (id),
  -- Litres; negative on the reversing row.
  volume_l    integer NOT NULL CHECK (volume_l <> 0),
  load_date   date NOT NULL,
  loaded_at   timestamptz NOT NULL DEFAULT now(),
  -- The recette in force on the load date, kept for good (a later version never rewrites a past load).
  recette_id  uuid NOT NULL REFERENCES public.recette (id),
  reverses_id uuid UNIQUE REFERENCES public.delivery (id),
  reason      text CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((reverses_id IS NULL) = (volume_l > 0)),
  CHECK (reverses_id IS NULL OR reason IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX delivery_order_idx ON public.delivery (order_id);
--> statement-breakpoint
CREATE INDEX delivery_date_idx ON public.delivery (load_date);
--> statement-breakpoint
CREATE TABLE public.delivery_return (
  id                uuid PRIMARY KEY,
  delivery_id       uuid NOT NULL UNIQUE REFERENCES public.delivery (id),
  returned_on       date NOT NULL,
  -- Concrete brought back unused (litres); it is lost, not given back to the stock.
  returned_volume_l integer NOT NULL DEFAULT 0 CHECK (returned_volume_l >= 0),
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.delivery ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_return ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_return FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.delivery, public.delivery_return FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.delivery, public.delivery_return TO belgobeton_app;
--> statement-breakpoint

-- The SECURITY DEFINER guards below read what the plant may not (the trucks' and recettes' tables belong to the migrator).
CREATE POLICY truck_definer_read ON public.truck FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY recette_definer_read ON public.recette FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY delivery_definer_read ON public.delivery FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- Not money: every signed-in role of the company reads loads. Plant, owner and partner create them; reversals are the
-- owner's and the partner's; the signed BL comes back through plant or office (A11).
CREATE POLICY delivery_read ON public.delivery FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant'));
--> statement-breakpoint
CREATE POLICY delivery_insert ON public.delivery FOR INSERT TO belgobeton_app
  WITH CHECK (created_by = ctx.user_id() AND (
    (ctx.role() IN ('owner', 'partner', 'plant') AND reverses_id IS NULL)
    OR (ctx.role() IN ('owner', 'partner') AND reverses_id IS NOT NULL)));
--> statement-breakpoint
CREATE POLICY delivery_return_read ON public.delivery_return FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant'));
--> statement-breakpoint
CREATE POLICY delivery_return_insert ON public.delivery_return FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'office', 'plant') AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.delivery');
--> statement-breakpoint
SELECT public.grant_support_read('public.delivery_return');
--> statement-breakpoint
SELECT audit.attach('public.delivery');
--> statement-breakpoint
SELECT audit.attach('public.delivery_return');
--> statement-breakpoint

-- Guard on a load: a live order, volume within the truck and within what is left to deliver, the recette in force on the load
-- date; a reversal negates its original exactly (once, never a reversal of a reversal).
CREATE FUNCTION public.delivery_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order  public.sales_order%ROWTYPE;
  v_truck  public.truck%ROWTYPE;
  v_recette public.recette%ROWTYPE;
  v_orig   public.delivery%ROWTYPE;
  v_loaded bigint;
  v_in_force uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('delivery:order:' || NEW.order_id::text, 0));
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.delivery WHERE id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'delivery: unknown load to cancel' USING ERRCODE = 'check_violation';
    END IF;
    IF v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'delivery: a cancellation cannot be cancelled' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.order_id <> v_orig.order_id OR NEW.truck_id <> v_orig.truck_id OR NEW.recette_id <> v_orig.recette_id
       OR NEW.volume_l <> -v_orig.volume_l OR NEW.load_date < v_orig.load_date THEN
      RAISE EXCEPTION 'delivery: a cancellation negates its load exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_order FROM public.sales_order WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'delivery: unknown order' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = v_order.id) THEN
    RAISE EXCEPTION 'delivery: the order is cancelled' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_truck FROM public.truck WHERE id = NEW.truck_id;
  IF NOT FOUND OR v_truck.status <> 'active' THEN
    RAISE EXCEPTION 'delivery: the truck is not available' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.volume_l > v_truck.capacity_l THEN
    RAISE EXCEPTION 'delivery: the load is more than the truck can carry' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(d.volume_l), 0) INTO v_loaded FROM public.delivery d WHERE d.order_id = NEW.order_id;
  IF v_loaded + NEW.volume_l > v_order.volume_l THEN
    RAISE EXCEPTION 'delivery: more than what is left to deliver' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_recette FROM public.recette WHERE id = NEW.recette_id;
  SELECT r.id INTO v_in_force FROM public.recette r
   WHERE r.concrete_type_id = v_order.concrete_type_id AND r.effective_from <= NEW.load_date
   ORDER BY r.effective_from DESC LIMIT 1;
  IF NOT FOUND OR v_recette.id IS DISTINCT FROM v_in_force OR v_recette.concrete_type_id <> v_order.concrete_type_id THEN
    RAISE EXCEPTION 'delivery: not the recette in force on the load date' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_guard BEFORE INSERT ON public.delivery
  FOR EACH ROW EXECUTE FUNCTION public.delivery_guard();
--> statement-breakpoint

CREATE FUNCTION public.delivery_return_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.delivery%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM public.delivery WHERE id = NEW.delivery_id;
  IF NOT FOUND OR v_d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery c WHERE c.reverses_id = v_d.id) THEN
    RAISE EXCEPTION 'delivery_return: not a live load' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.returned_volume_l > v_d.volume_l OR NEW.returned_on < v_d.load_date THEN
    RAISE EXCEPTION 'delivery_return: more than was loaded, or before the load' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_return_guard BEFORE INSERT ON public.delivery_return
  FOR EACH ROW EXECUTE FUNCTION public.delivery_return_guard();
--> statement-breakpoint

-- The plant and the partner create loads (A11), so they may number a delivery note, and only that: the other prefixes stay
-- with owner and office.
CREATE OR REPLACE FUNCTION public.next_doc_number(p_prefix text, p_year integer, p_width integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.role();
  v_n    integer;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'partner', 'plant', 'system')
     OR (v_role IN ('partner', 'plant') AND p_prefix <> 'BL') THEN
    RAISE EXCEPTION 'next_doc_number: role % may not number documents', coalesce(v_role, '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.doc_sequence AS s (prefix, year, last_value) VALUES (p_prefix, p_year, 1)
  ON CONFLICT (prefix, year) DO UPDATE SET last_value = s.last_value + 1
  RETURNING s.last_value INTO v_n;
  RETURN p_prefix || '-' || p_year::text || '-' || lpad(v_n::text, greatest(p_width, length(v_n::text)), '0');
END $$;
--> statement-breakpoint

-- The two operations parameters the plant needs to see (the 90-minute rule), without reading the parameter table.
CREATE FUNCTION public.ops_parameter(p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant', 'system') THEN
    RAISE EXCEPTION 'ops_parameter: role % may not read parameters', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key NOT IN ('concrete_limit_min', 'unloading_min') THEN
    RAISE EXCEPTION 'ops_parameter: % is not an operations parameter', p_key USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT p.value FROM public.parameter p WHERE p.key = p_key);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.ops_parameter(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ops_parameter(text) TO belgobeton_app;
