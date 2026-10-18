-- T14: the app role may read the audit log through RLS (SPEC §4: owner/partner all, office/plant own actions).
-- ENABLE, not FORCE (CP2): the SECURITY DEFINER writers run as the owner and must read the latest hash.
-- Registered in src/modules/platform-security/domain/table-access.ts.
ALTER TABLE public.audit_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON public.audit_event TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY audit_event_read_all ON public.audit_event FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
CREATE POLICY audit_event_read_own ON public.audit_event FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('office', 'plant') AND actor_user_id = ctx.user_id());
