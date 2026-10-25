-- operations O10 (SPEC-operations §7.3, AC-OPS-16, 17): trip tracking. What really happened on a planned rotation, one tap per
-- step: loaded (the load itself, it makes the BL), departed, arrived on site, unloading started, unloading finished, back.
-- Insert-only, one row per trip and step, in order, never before the previous step. Quantities and times only, no money.
-- Waiting time, unloading time, delays are derived from these rows; nothing is stored twice.
CREATE TABLE public.trip_event (
  id          uuid PRIMARY KEY,
  trip_id     uuid NOT NULL REFERENCES public.trip_plan (id),
  step        text NOT NULL CHECK (step IN ('loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back')),
  -- The clock's instant (real or simulated), not the database's: a demo that moves the clock moves the events with it.
  at          timestamptz NOT NULL,
  -- The load that was made, on the `loaded` step only; a load belongs to one rotation.
  delivery_id uuid UNIQUE REFERENCES public.delivery (id),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, step),
  CHECK ((step = 'loaded') = (delivery_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX trip_event_trip_idx ON public.trip_event (trip_id);
--> statement-breakpoint
ALTER TABLE public.trip_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trip_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.trip_event FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.trip_event TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY trip_event_read ON public.trip_event FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY trip_event_insert ON public.trip_event FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY trip_event_definer_read ON public.trip_event FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY trip_plan_cancellation_definer_read ON public.trip_plan_cancellation FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.trip_event');
--> statement-breakpoint
SELECT audit.attach('public.trip_event');
--> statement-breakpoint

-- The guard: the rotation is live (not cancelled), the step follows the previous one (the first is `loaded`), it is not
-- earlier than the previous step, and a load belongs to this rotation's order and truck and is a live load.
CREATE FUNCTION public.trip_event_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_trip   public.trip_plan%ROWTYPE;
  v_steps  text[] := ARRAY['loaded', 'departed', 'arrived', 'unloading_started', 'unloading_finished', 'back'];
  v_index  integer := array_position(v_steps, NEW.step);
  v_prev   public.trip_event%ROWTYPE;
  v_d      public.delivery%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('trip_event:' || NEW.trip_id::text, 0));
  SELECT * INTO v_trip FROM public.trip_plan WHERE id = NEW.trip_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = NEW.trip_id) THEN
    RAISE EXCEPTION 'trip_event: not a live rotation' USING ERRCODE = 'check_violation';
  END IF;
  IF v_index > 1 THEN
    SELECT * INTO v_prev FROM public.trip_event WHERE trip_id = NEW.trip_id AND step = v_steps[v_index - 1];
    IF NOT FOUND THEN
      RAISE EXCEPTION 'trip_event: the previous step is not recorded' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.at < v_prev.at THEN
      RAISE EXCEPTION 'trip_event: before the previous step' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.step = 'loaded' THEN
    SELECT * INTO v_d FROM public.delivery WHERE id = NEW.delivery_id;
    IF NOT FOUND OR v_d.reverses_id IS NOT NULL OR v_d.order_id <> v_trip.order_id OR v_d.truck_id <> v_trip.truck_id
       OR EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = v_d.id) THEN
      RAISE EXCEPTION 'trip_event: not a live load of this rotation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_event_guard BEFORE INSERT ON public.trip_event
  FOR EACH ROW EXECUTE FUNCTION public.trip_event_guard();
--> statement-breakpoint

-- A rotation that has started (it has an event) can no longer be cancelled by replanning the day.
CREATE FUNCTION public.trip_plan_cancellation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = NEW.trip_id) THEN
    RAISE EXCEPTION 'trip_plan: a rotation that has started cannot be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_plan_cancellation_guard BEFORE INSERT ON public.trip_plan_cancellation
  FOR EACH ROW EXECUTE FUNCTION public.trip_plan_cancellation_guard();
