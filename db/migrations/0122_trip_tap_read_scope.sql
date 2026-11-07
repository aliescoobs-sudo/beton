-- Privacy residual of group B: who may read the raw taps of a named driver (trip_event, trip_driver_report).
-- Looked for every reader. trip_event: the dispatch board (listTrips, permission dispatch.read: owner, app_admin, plant manager and the read-only
-- support) and the recording of a step (trips.track: owner, app_admin, plant manager) read it with the application's own login, so partner and support KEEP
-- their read of trip_event: it is the dispatch record (decision 183). What was too wide is its SCOPE: a plant manager read the events of EVERY plant.
-- trip_driver_report: NOTHING in the application reads it with the application's login. Every reader is a SECURITY DEFINER function (driver_trips,
-- trip_timing, trip_stage_estimate, the "started" guard, the BL photo guard), which uses the migrator's own policy. So the direct read of partner,
-- office and support served no feature and is closed; owner and the plant manager (own plant only) keep a direct read as the minimal management view.
DROP POLICY trip_event_read ON public.trip_event;
--> statement-breakpoint
CREATE POLICY trip_event_read ON public.trip_event FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = trip_event.trip_id AND p.plant_id = ctx.plant_scope())));
--> statement-breakpoint
DROP POLICY trip_driver_report_read ON public.trip_driver_report;
--> statement-breakpoint
DROP POLICY support_read ON public.trip_driver_report;
--> statement-breakpoint
CREATE POLICY trip_driver_report_read ON public.trip_driver_report FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'plant')
         AND (ctx.plant_scope() IS NULL OR EXISTS (SELECT 1 FROM public.trip_plan p WHERE p.id = trip_driver_report.trip_id AND p.plant_id = ctx.plant_scope())));
