-- master-data T13 (SPEC-master-data §2, R23): trucks and their status log. Structure only: the pilot trucks come from
-- the pilot seed (decision 79).
-- truck: managers write (and archive; no DELETE). Only plate, capacity and status are updatable (column grants); the
-- code never changes (trigger). Every signed-in role reads.
-- truck_status_log: insert-only (a correction is a new entry, e.g. 'available' ends a breakdown early). Written by the
-- plant (it knows when a truck breaks down or a road is blocked) and by the managers (trucks.status.write); office
-- cannot. The plant cannot touch truck.
-- The period is [from_date, to_date): to_date is the first day the truck is back, NULL = until further notice.
CREATE TABLE public.truck (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE CHECK (code ~ '^T[0-9]{1,3}$'),
  plate      text NOT NULL UNIQUE CHECK (plate = btrim(plate) AND length(plate) BETWEEN 3 AND 20),
  -- Litres: an integer, like every quantity.
  capacity_l integer NOT NULL DEFAULT 8000 CHECK (capacity_l BETWEEN 1000 AND 30000),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE FUNCTION public.truck_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'truck.code is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER truck_guard BEFORE UPDATE ON public.truck
  FOR EACH ROW EXECUTE FUNCTION public.truck_guard();
--> statement-breakpoint
ALTER TABLE public.truck ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.truck FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.truck FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.truck TO belgobeton_app;
--> statement-breakpoint
GRANT UPDATE (plate, capacity_l, status) ON public.truck TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.truck TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY truck_read ON public.truck FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'system'));
--> statement-breakpoint
CREATE POLICY truck_insert ON public.truck FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND status = 'active');
--> statement-breakpoint
CREATE POLICY truck_update ON public.truck FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner')) WITH CHECK (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
CREATE POLICY truck_insert_system ON public.truck FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system' AND status = 'active');
--> statement-breakpoint
SELECT audit.attach('public.truck');
--> statement-breakpoint
CREATE TABLE public.truck_status_log (
  id         uuid PRIMARY KEY,
  truck_id   uuid NOT NULL REFERENCES public.truck (id),
  status     text NOT NULL CHECK (status IN ('available', 'breakdown', 'roadblock')),
  from_date  date NOT NULL,
  to_date    date,
  reason     text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  logged_by  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date IS NULL OR to_date > from_date)
);
--> statement-breakpoint
CREATE INDEX truck_status_log_truck_idx ON public.truck_status_log (truck_id, from_date);
--> statement-breakpoint
ALTER TABLE public.truck_status_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.truck_status_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.truck_status_log FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.truck_status_log TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT ON public.truck_status_log TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY truck_status_log_read ON public.truck_status_log FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'system'));
--> statement-breakpoint
CREATE POLICY truck_status_log_insert ON public.truck_status_log FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND logged_by = ctx.user_id());
--> statement-breakpoint
SELECT audit.attach('public.truck_status_log');
