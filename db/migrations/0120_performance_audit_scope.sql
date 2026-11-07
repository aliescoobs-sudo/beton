-- R14-02: the audit copies of everything that can carry performance information about a named driver are read by the owner and app_admin only.
-- 0118 named two tables (the delays and the change log). The explanation a manager types for a reassignment or a postponement used to be copied
-- into older, broader tables (trip_plan.driver_override_reason, trip_plan_cancellation.reason) whose audit rows partner and support read; the
-- service now writes a neutral code there, and the audit of every table that is, or was, a secondary copy is restricted by table name so that
-- ROWS WRITTEN BEFORE THIS CHANGE (which may hold the free text, and which an append-only table cannot rewrite) are covered too.
--   trip_delay, trip_dispatch_change, trip_estimate_override, trip_overlap_override: the restricted tables themselves (explanations, delays).
--   trip_plan, trip_plan_cancellation: driver, reason columns.
--   trip_event, trip_driver_report: the actual times of a named driver's taps.
-- The operational tables keep their read rules (plant, owner, partner and support read the plan and the events: that is the dispatch record,
-- decision 183 says so); this closes the side door through the audit trail, not the operational view.
DROP POLICY audit_event_trip_performance ON public.audit_event;
--> statement-breakpoint
CREATE POLICY audit_event_trip_performance ON public.audit_event AS RESTRICTIVE FOR SELECT TO belgobeton_app
  USING (table_name NOT IN ('trip_delay', 'trip_dispatch_change', 'trip_estimate_override', 'trip_overlap_override',
                            'trip_plan', 'trip_plan_cancellation', 'trip_event', 'trip_driver_report')
         OR ctx.actor_role() IN ('owner', 'app_admin'));
