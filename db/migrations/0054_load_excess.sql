-- Review of CP-OPS-1-3, point 4: a load above the order volume is allowed (the plant is never blocked), warned about and
-- recorded for the owner to confirm; it is billed at the order's price like any other load. The excess is a fact written by the
-- database itself when a load takes the order past its volume (no service can forget it); whether it is within the tolerance
-- (parameter load_excess_tolerance_bp) is derived when it is read. Volumes only, no money on these tables.

CREATE OR REPLACE FUNCTION public.delivery_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order  public.sales_order%ROWTYPE;
  v_truck  public.truck%ROWTYPE;
  v_recette public.recette%ROWTYPE;
  v_orig   public.delivery%ROWTYPE;
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
  -- No check against what is left to deliver any more: the excess is recorded by the AFTER trigger below.
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

CREATE TABLE public.delivery_excess (
  id          uuid PRIMARY KEY,
  delivery_id uuid NOT NULL UNIQUE REFERENCES public.delivery (id),
  -- The litres of this load that go past the order volume (never more than the load itself).
  excess_l    integer NOT NULL CHECK (excess_l > 0),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.delivery_excess_confirmation (
  id          uuid PRIMARY KEY,
  excess_id   uuid NOT NULL UNIQUE REFERENCES public.delivery_excess (id),
  note        text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 500)),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.delivery_excess ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_excess FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_excess_confirmation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_excess_confirmation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.delivery_excess, public.delivery_excess_confirmation FROM PUBLIC;
--> statement-breakpoint
-- The excess row is written by the trigger (no INSERT grant for the application); the owner confirms.
GRANT SELECT ON public.delivery_excess TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.delivery_excess_confirmation TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY delivery_excess_read ON public.delivery_excess FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant'));
--> statement-breakpoint
CREATE POLICY delivery_excess_definer_read ON public.delivery_excess FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY delivery_excess_definer_insert ON public.delivery_excess FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY delivery_excess_confirmation_read ON public.delivery_excess_confirmation FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
CREATE POLICY delivery_excess_confirmation_insert ON public.delivery_excess_confirmation FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.delivery_excess');
--> statement-breakpoint
SELECT public.grant_support_read('public.delivery_excess_confirmation');
--> statement-breakpoint
SELECT audit.attach('public.delivery_excess');
--> statement-breakpoint
SELECT audit.attach('public.delivery_excess_confirmation');
--> statement-breakpoint

-- After a load, if the order has now been loaded past its volume, record by how much this load is responsible. Written by
-- the database so that no path (plant, scenario, anything) can load past the order without leaving the record.
CREATE FUNCTION public.delivery_record_excess() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_volume integer;
  v_total  bigint;
  v_excess bigint;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT o.volume_l INTO v_volume FROM public.sales_order o WHERE o.id = NEW.order_id;
  SELECT coalesce(sum(d.volume_l), 0) INTO v_total FROM public.delivery d WHERE d.order_id = NEW.order_id;
  v_excess := least(NEW.volume_l::bigint, v_total - v_volume);
  IF v_excess > 0 THEN
    INSERT INTO public.delivery_excess (id, delivery_id, excess_l, created_by)
    VALUES (gen_random_uuid(), NEW.id, v_excess, NEW.created_by);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_record_excess AFTER INSERT ON public.delivery
  FOR EACH ROW EXECUTE FUNCTION public.delivery_record_excess();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ops_parameter(p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant', 'system') THEN
    RAISE EXCEPTION 'ops_parameter: role % may not read parameters', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key NOT IN ('concrete_limit_min', 'unloading_min', 'load_excess_tolerance_bp') THEN
    RAISE EXCEPTION 'ops_parameter: % is not an operations parameter', p_key USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT p.value FROM public.parameter p WHERE p.key = p_key);
END $$;
