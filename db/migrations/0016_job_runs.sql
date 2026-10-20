-- T23 (SPEC-clock §3): one row per (job, business day). The unique key is what makes a second run a no-op; the claim,
-- the handler's writes and the final status share one transaction run by the 'system' actor (see job-runner.ts).
CREATE TABLE public.scheduled_job_run (
  id            uuid PRIMARY KEY,
  job_key       text NOT NULL CHECK (job_key ~ '^[a-z][a-z0-9-]*$'),
  business_date date NOT NULL,
  status        text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  ran_at        timestamptz NOT NULL,
  sim_at        timestamptz,
  run_by        uuid NOT NULL,
  error         text,
  UNIQUE (job_key, business_date)
);
--> statement-breakpoint
ALTER TABLE public.scheduled_job_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.scheduled_job_run FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.scheduled_job_run FROM PUBLIC;
--> statement-breakpoint
-- No DELETE: run history is kept. The owner/partner read it (jobs screen later); only the system actor writes.
GRANT SELECT ON public.scheduled_job_run TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.scheduled_job_run TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY scheduled_job_run_read ON public.scheduled_job_run FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'system'));
--> statement-breakpoint
CREATE POLICY scheduled_job_run_insert ON public.scheduled_job_run FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY scheduled_job_run_update ON public.scheduled_job_run FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
SELECT audit.attach('public.scheduled_job_run');
