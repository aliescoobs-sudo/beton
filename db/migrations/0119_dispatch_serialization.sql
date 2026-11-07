-- R14-01: one lock discipline for cancelling, starting and replacing a rotation.
-- Lock order, always: the DAY ('trip_plan_day:<date>'), then the TRIPS of the day by id ('trip_event:<trip>', the key the event writer
-- already takes), and only then any audited write (the audit chain takes its own global lock until commit, so a lock taken after an audited
-- write could wait for a writer that is waiting for the audit lock). The dispatch service takes all of them first and re-reads the state;
-- the guards below take the same locks again (a lock held by the same transaction costs nothing) so the rule also holds for any other writer.

-- 1. "Started" is one definition: the plant's tracking has an event for the rotation, OR the driver reported that loading began.
CREATE FUNCTION public.trip_started(p_trip uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = p_trip)
      OR EXISTS (SELECT 1 FROM public.trip_driver_report r WHERE r.trip_id = p_trip AND r.kind = 'loading_started')
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.trip_started(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.trip_started(uuid) TO belgobeton_app;
--> statement-breakpoint

-- 2. A driver's report (loading began, m3 unloaded) is a start too: it takes the trip's lock and refuses a rotation that was cancelled.
CREATE FUNCTION public.trip_driver_report_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || NEW.trip_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = NEW.trip_id)
     OR EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = NEW.trip_id) THEN
    RAISE EXCEPTION 'trip_driver_report: not a live rotation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_driver_report_guard BEFORE INSERT ON public.trip_driver_report
  FOR EACH ROW EXECUTE FUNCTION public.trip_driver_report_guard();
--> statement-breakpoint

-- 3. The cancellation: day lock, then the trip's lock (the event writer's key), and only then the decision, on the full definition of started.
CREATE OR REPLACE FUNCTION public.trip_plan_cancellation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_date date;
BEGIN
  SELECT p.trip_date INTO v_date FROM public.trip_plan p WHERE p.id = NEW.trip_id;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('trip_plan_day:' || v_date::text, 0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || NEW.trip_id::text, 0));
  IF public.trip_started(NEW.trip_id) THEN
    RAISE EXCEPTION 'trip_plan: a rotation that has started cannot be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 4. A double-booking (a driver or a truck on two live rotations that overlap in time) is refused by the dispatch service, under the day
--    lock, unless the caller gives an explicit override reason; the override is a row written through the door below (audited, its reason
--    restricted like the change log). The database does not refuse overlaps by itself: the training seed and the test fixtures legitimately
--    write rotations of one truck at the same time, so the rule lives where the plan is judged.
CREATE TABLE public.trip_overlap_override (
  id         uuid PRIMARY KEY,
  batch_id   uuid NOT NULL UNIQUE,
  trip_date  date NOT NULL,
  plant_id   uuid REFERENCES public.plant (id),
  kinds      text[] NOT NULL CHECK (cardinality(kinds) >= 1 AND kinds <@ ARRAY['driver', 'truck']::text[]),
  reason     text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 300),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER trip_overlap_override_append_only BEFORE UPDATE OR DELETE ON public.trip_overlap_override FOR EACH ROW EXECUTE FUNCTION public._forbid_change();
--> statement-breakpoint
ALTER TABLE public.trip_overlap_override ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trip_overlap_override FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.trip_overlap_override FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.trip_overlap_override TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY trip_overlap_override_definer ON public.trip_overlap_override FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY trip_overlap_override_read ON public.trip_overlap_override FOR SELECT TO belgobeton_app USING (
  ctx.actor_role() IN ('owner', 'app_admin') OR (ctx.actor_role() = 'plant_manager' AND plant_id IS NOT NULL AND plant_id = ctx.plant_scope()));
--> statement-breakpoint
SELECT audit.attach('public.trip_overlap_override');
--> statement-breakpoint

CREATE FUNCTION public.record_dispatch_overlap(p_batch uuid, p_date date, p_kinds text[], p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role(); v_id uuid := gen_random_uuid(); v_plant uuid;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'app_admin', 'plant_manager') THEN
    RAISE EXCEPTION 'record_dispatch_overlap: role % may not', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_plant := ctx.plant_scope();
  IF v_role = 'plant_manager' AND v_plant IS NULL THEN
    RAISE EXCEPTION 'record_dispatch_overlap: no plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.trip_overlap_override (id, batch_id, trip_date, plant_id, kinds, reason, created_by)
  VALUES (v_id, p_batch, p_date, v_plant, p_kinds, btrim(coalesce(p_reason, '')), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_dispatch_overlap(uuid, date, text[], text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_dispatch_overlap(uuid, date, text[], text) TO belgobeton_app;
--> statement-breakpoint

-- 5. The plan guard (0074) plus: the day lock, and one live rotation per work item (day, order, number), whatever batch wrote it.
CREATE OR REPLACE FUNCTION public.trip_plan_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order  public.sales_order%ROWTYPE;
  v_truck  public.truck%ROWTYPE;
  v_driver public.driver%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_plan_day:' || NEW.trip_date::text, 0));
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
  -- One work item (day, order, number) has one live rotation, whatever batch wrote it.
  IF EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id <> NEW.id AND p.trip_date = NEW.trip_date AND p.order_id = NEW.order_id AND p.seq = NEW.seq
               AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = p.id)) THEN
    RAISE EXCEPTION 'trip_plan: this rotation of the order is already planned that day' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;
