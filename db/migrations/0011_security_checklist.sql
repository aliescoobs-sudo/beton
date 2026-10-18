-- T21: pre-real-data security checklist (SPEC §8, D37).
-- Manual marks: owner writes; owner/partner read; the system role reads (banner, REAL_DATA boot guard).
CREATE TABLE public.security_checklist_item (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z0-9_]+$'),
  status     text NOT NULL CHECK (status IN ('open', 'done')),
  evidence   text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 2000),
  checked_by uuid NOT NULL,
  checked_at timestamptz NOT NULL
);
--> statement-breakpoint
ALTER TABLE public.security_checklist_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.security_checklist_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.security_checklist_item FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.security_checklist_item TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT ON public.security_checklist_item TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY checklist_read ON public.security_checklist_item FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'system'));
--> statement-breakpoint
CREATE POLICY checklist_insert ON public.security_checklist_item FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY checklist_update ON public.security_checklist_item FOR UPDATE TO belgobeton_app
  USING (ctx.role() = 'owner') WITH CHECK (ctx.role() = 'owner');
--> statement-breakpoint
SELECT audit.attach('public.security_checklist_item');
--> statement-breakpoint

-- Automated evidence, append-only: written by the system actor (restore test), read by owner/partner/system.
CREATE TABLE public.security_check_run (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    text NOT NULL CHECK (key IN ('restore_test')),
  ok     boolean NOT NULL,
  at     timestamptz NOT NULL,
  detail text CHECK (length(detail) <= 500)
);
--> statement-breakpoint
ALTER TABLE public.security_check_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.security_check_run FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.security_check_run FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.security_check_run TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.security_check_run TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY check_run_read ON public.security_check_run FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'system'));
--> statement-breakpoint
CREATE POLICY check_run_insert ON public.security_check_run FOR INSERT TO belgobeton_system WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
SELECT audit.attach('public.security_check_run');
--> statement-breakpoint

-- Who created each account (seed-account check): set by createUser.
ALTER TABLE "user" ADD COLUMN "createdBy" text;
