-- integration I4.1 (AC-INT-20, decision 91 as answered by Ali): each truck has a default driver in its record; dispatch
-- proposes it; a rotation that carries another driver (or none) says why. Quantities and names only: no money. Structure only:
-- the pilot's defaults come from db:scenario (decision 79).
--
-- truck.default_driver_id: set by the managers through the column grant (the truck policies already confine updates to owner
-- and partner); the driver must be active when it is set. A later change of default never rewrites a saved rotation.
-- trip_plan.driver_override_reason: stored with the rotation, required exactly when the rotation's driver differs from the
-- truck's default at that moment (a different driver, or none where there is a default); refused when there is no override.
ALTER TABLE public.truck ADD COLUMN default_driver_id uuid REFERENCES public.driver (id);
--> statement-breakpoint
GRANT UPDATE (default_driver_id) ON public.truck TO belgobeton_app;
--> statement-breakpoint
CREATE FUNCTION public.truck_default_driver_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.default_driver_id IS NOT NULL
     AND NEW.default_driver_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.default_driver_id END) THEN
    SELECT status INTO v_status FROM public.driver WHERE id = NEW.default_driver_id;
    IF NOT FOUND OR v_status <> 'active' THEN
      RAISE EXCEPTION 'truck: the default driver is not active' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER truck_default_driver_guard BEFORE INSERT OR UPDATE ON public.truck
  FOR EACH ROW EXECUTE FUNCTION public.truck_default_driver_guard();
--> statement-breakpoint
ALTER TABLE public.trip_plan ADD COLUMN driver_override_reason text
  CHECK (driver_override_reason IS NULL OR (driver_override_reason = btrim(driver_override_reason) AND length(driver_override_reason) BETWEEN 1 AND 300));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.trip_plan_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order  public.sales_order%ROWTYPE;
  v_truck  public.truck%ROWTYPE;
  v_driver public.driver%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.sales_order WHERE id = NEW.order_id;
  IF NOT FOUND OR v_order.reverses_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = v_order.id) THEN
    RAISE EXCEPTION 'trip_plan: not a live order' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_truck FROM public.truck WHERE id = NEW.truck_id;
  IF NOT FOUND OR NOT public.truck_available_on(NEW.truck_id, NEW.trip_date) THEN
    RAISE EXCEPTION 'trip_plan: the truck is not available that day' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.volume_l > v_truck.capacity_l THEN
    RAISE EXCEPTION 'trip_plan: more than the truck can carry' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.driver_id IS NOT NULL THEN
    SELECT * INTO v_driver FROM public.driver WHERE id = NEW.driver_id;
    IF NOT FOUND OR v_driver.status <> 'active' THEN
      RAISE EXCEPTION 'trip_plan: the driver is not active' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- An override of the truck's default driver says why; a rotation on the default carries no reason.
  IF v_truck.default_driver_id IS NOT NULL AND NEW.driver_id IS DISTINCT FROM v_truck.default_driver_id THEN
    IF NEW.driver_override_reason IS NULL THEN
      RAISE EXCEPTION 'trip_plan: a driver other than the truck default needs a reason' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.driver_override_reason IS NOT NULL THEN
    RAISE EXCEPTION 'trip_plan: a reason without an override' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
