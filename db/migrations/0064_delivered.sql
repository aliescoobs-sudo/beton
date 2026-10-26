-- integration I1.1 (SPEC-integration AC-INT-01): a load is delivered when its rotation reaches "unloading finished" (the
-- tracking step writes this row through a trigger, with the step's own instant), or, for a load made outside a rotation, when
-- the plant, the owner or the partner says so. One row per load, insert-only; a cancelled or wholly refused load keeps its row
-- but never counts (the view below). Quantities and times only, no money: every role that reads loads reads it.
CREATE TABLE public.delivery_delivered (
  id            uuid PRIMARY KEY,
  delivery_id   uuid NOT NULL UNIQUE REFERENCES public.delivery (id),
  -- The clock's instant (real or simulated): the tracking step's own `at`, or the moment of a manual mark.
  at            timestamptz NOT NULL,
  -- The `unloading_finished` event that made it, else null (a load outside any rotation, marked by hand).
  trip_event_id uuid UNIQUE REFERENCES public.trip_event (id),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.delivery_delivered ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_delivered FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.delivery_delivered FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.delivery_delivered TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY delivery_delivered_read ON public.delivery_delivered FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant'));
--> statement-breakpoint
CREATE POLICY delivery_delivered_insert ON public.delivery_delivered FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND created_by = ctx.user_id());
--> statement-breakpoint
-- The tracking trigger below writes as the migrator (SECURITY DEFINER), on behalf of the plant that tapped the step.
CREATE POLICY delivery_delivered_definer_read ON public.delivery_delivered FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY delivery_delivered_definer_insert ON public.delivery_delivered FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.delivery_delivered');
--> statement-breakpoint
SELECT audit.attach('public.delivery_delivered');
--> statement-breakpoint

-- The guard: a live load (not a cancellation, not cancelled). A load that belongs to a rotation is delivered only by that
-- rotation's `unloading_finished` step; a load outside any rotation is marked by hand (no event), never before it was loaded.
CREATE FUNCTION public.delivery_delivered_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.delivery%ROWTYPE;
  v_e public.trip_event%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM public.delivery WHERE id = NEW.delivery_id;
  IF NOT FOUND OR v_d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery c WHERE c.reverses_id = v_d.id) THEN
    RAISE EXCEPTION 'delivery_delivered: not a live load' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.trip_event_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.trip_event e WHERE e.delivery_id = NEW.delivery_id) THEN
      RAISE EXCEPTION 'delivery_delivered: this load follows its rotation' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO v_e FROM public.trip_event WHERE id = NEW.trip_event_id;
    IF NOT FOUND OR v_e.step <> 'unloading_finished' OR NEW.at <> v_e.at OR NOT EXISTS (
         SELECT 1 FROM public.trip_event l
          WHERE l.trip_id = v_e.trip_id AND l.step = 'loaded' AND l.delivery_id = NEW.delivery_id) THEN
      RAISE EXCEPTION 'delivery_delivered: not the unloading step of this load' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_delivered_guard BEFORE INSERT ON public.delivery_delivered
  FOR EACH ROW EXECUTE FUNCTION public.delivery_delivered_guard();
--> statement-breakpoint

-- The tracking step that finishes the unloading delivers its load, in the same transaction, with the step's instant.
CREATE FUNCTION public.trip_event_delivered() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_delivery uuid;
BEGIN
  SELECT l.delivery_id INTO v_delivery FROM public.trip_event l WHERE l.trip_id = NEW.trip_id AND l.step = 'loaded';
  IF v_delivery IS NOT NULL THEN
    INSERT INTO public.delivery_delivered (id, delivery_id, at, trip_event_id, created_by)
    VALUES (gen_random_uuid(), v_delivery, NEW.at, NEW.id, NEW.created_by);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER trip_event_delivered AFTER INSERT ON public.trip_event
  FOR EACH ROW WHEN (NEW.step = 'unloading_finished') EXECUTE FUNCTION public.trip_event_delivered();
--> statement-breakpoint

-- The loads that count as delivered: delivered, not cancelled, not wholly lost (a load whose whole volume was refused or
-- brought back never reached the client). The caller's own row-level security applies (security_invoker).
CREATE VIEW public.delivered_load WITH (security_invoker = true) AS
  SELECT d.id AS delivery_id, d.bl_no, d.order_id, d.volume_l, d.load_date, dd.at AS delivered_at
    FROM public.delivery d
    JOIN public.delivery_delivered dd ON dd.delivery_id = d.id
   WHERE d.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.delivery c WHERE c.reverses_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_loss l WHERE l.delivery_id = d.id AND l.volume_l >= d.volume_l);
--> statement-breakpoint
REVOKE ALL ON public.delivered_load FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.delivered_load TO belgobeton_app;
--> statement-breakpoint
ALTER VIEW public.delivered_load SET (security_barrier = true);
