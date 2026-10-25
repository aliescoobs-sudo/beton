-- operations O9 (SPEC-operations §7, AC-OPS-12…15): the daily dispatch. Drivers, the rotations planned for a day and their
-- cancellations. Quantities and times only: nothing here carries a price, a total or a payment. Structure only: the pilot
-- drivers come from the pilot scenario (decision 79).
--
-- driver: a first name and a code (name only, law 09-08). Owner and partner write and archive; the operations roles read.
-- trip_plan: one planned rotation (order, truck, driver, volume, the five milestones in minutes from midnight). Insert-only;
-- the times are stored facts, so a later parameter change never rewrites a saved plan. Owner, partner and plant plan.
-- trip_plan_cancellation: replanning a day cancels its live rotations (reason) and inserts the new ones; one per rotation.
CREATE TABLE public.driver (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE CHECK (code ~ '^CH-[0-9]{2,4}$'),
  name       text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION public.driver_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'driver.code is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER driver_guard BEFORE UPDATE ON public.driver
  FOR EACH ROW EXECUTE FUNCTION public.driver_guard();
--> statement-breakpoint
ALTER TABLE public.driver ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.driver FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.driver FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.driver TO belgobeton_app;
--> statement-breakpoint
GRANT UPDATE (name, status) ON public.driver TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY driver_read ON public.driver FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY driver_insert ON public.driver FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND created_by = ctx.user_id() AND status = 'active');
--> statement-breakpoint
CREATE POLICY driver_update ON public.driver FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner')) WITH CHECK (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
CREATE POLICY driver_definer_read ON public.driver FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.driver');
--> statement-breakpoint
SELECT audit.attach('public.driver');
--> statement-breakpoint

CREATE TABLE public.trip_plan (
  id            uuid PRIMARY KEY,
  -- One save of a day's plan: the rotations of a batch are numbered per order from 1.
  batch_id      uuid NOT NULL,
  trip_date     date NOT NULL,
  order_id      uuid NOT NULL REFERENCES public.sales_order (id),
  seq           integer NOT NULL CHECK (seq >= 1),
  truck_id      uuid NOT NULL REFERENCES public.truck (id),
  driver_id     uuid REFERENCES public.driver (id),
  -- Litres.
  volume_l      integer NOT NULL CHECK (volume_l > 0),
  load_min      integer NOT NULL CHECK (load_min BETWEEN 0 AND 2880),
  depart_min    integer NOT NULL,
  arrive_min    integer NOT NULL,
  unload_end_min integer NOT NULL,
  back_min      integer NOT NULL CHECK (back_min <= 2880),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (load_min <= depart_min AND depart_min <= arrive_min AND arrive_min <= unload_end_min AND unload_end_min <= back_min),
  UNIQUE (batch_id, order_id, seq)
);
--> statement-breakpoint
CREATE INDEX trip_plan_date_idx ON public.trip_plan (trip_date);
--> statement-breakpoint
CREATE INDEX trip_plan_order_idx ON public.trip_plan (order_id);
--> statement-breakpoint
CREATE TABLE public.trip_plan_cancellation (
  id         uuid PRIMARY KEY,
  trip_id    uuid NOT NULL UNIQUE REFERENCES public.trip_plan (id),
  reason     text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.trip_plan ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trip_plan FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trip_plan_cancellation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trip_plan_cancellation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.trip_plan, public.trip_plan_cancellation FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.trip_plan, public.trip_plan_cancellation TO belgobeton_app;
--> statement-breakpoint
-- Not money: the plant, owner and partner read the plan (office is blind to orders and never sees it); support reads.
CREATE POLICY trip_plan_read ON public.trip_plan FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY trip_plan_insert ON public.trip_plan FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY trip_plan_cancellation_read ON public.trip_plan_cancellation FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY trip_plan_cancellation_insert ON public.trip_plan_cancellation FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY trip_plan_definer_read ON public.trip_plan FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY truck_status_log_definer_read ON public.truck_status_log FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.trip_plan');
--> statement-breakpoint
SELECT public.grant_support_read('public.trip_plan_cancellation');
--> statement-breakpoint
SELECT audit.attach('public.trip_plan');
--> statement-breakpoint
SELECT audit.attach('public.trip_plan_cancellation');
--> statement-breakpoint

-- Whether a truck can be planned on a date: the SQL twin of master-data `isTruckAvailable` (an archived truck never; else
-- the latest log entry that covers the day decides, a day no entry covers is available). The twin is checked against the
-- TypeScript function on random logs (tests/dispatch.int.test.ts). Called only by the guard below: no role executes it directly.
CREATE FUNCTION public.truck_available_on(p_truck uuid, p_date date) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_log    text;
BEGIN
  SELECT t.status INTO v_status FROM public.truck t WHERE t.id = p_truck;
  IF NOT FOUND OR v_status <> 'active' THEN
    RETURN false;
  END IF;
  SELECT l.status INTO v_log FROM public.truck_status_log l
   WHERE l.truck_id = p_truck AND l.from_date <= p_date AND (l.to_date IS NULL OR p_date < l.to_date)
   ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
  RETURN v_log IS NULL OR v_log = 'available';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.truck_available_on(uuid, date) FROM PUBLIC;
--> statement-breakpoint

-- The two rules that are safety, not preference: a truck that is not available that day (breakdown log) cannot be planned,
-- and a rotation cannot carry more than the truck. A live order and an active driver complete it.
CREATE FUNCTION public.trip_plan_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_plan_guard BEFORE INSERT ON public.trip_plan
  FOR EACH ROW EXECUTE FUNCTION public.trip_plan_guard();
--> statement-breakpoint

-- The operations parameters the roles that load, plan and read trucks may read (the plant cannot read the parameter table;
-- support reads everything, read-only).
CREATE OR REPLACE FUNCTION public.ops_parameter(p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant', 'support', 'system') THEN
    RAISE EXCEPTION 'ops_parameter: role % may not read parameters', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key NOT IN ('concrete_limit_min', 'unloading_min', 'load_excess_tolerance_bp', 'loading_min', 'return_extra_min',
                   'working_min', 'day_start_min', 'default_one_way_min') THEN
    RAISE EXCEPTION 'ops_parameter: % is not an operations parameter', p_key USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT p.value FROM public.parameter p WHERE p.key = p_key);
END $$;
