-- master-data T2 (SPEC-master-data §2): delivery zones. The pattern every master-data table follows:
-- FORCE RLS, audit trigger, UPDATE but no DELETE/TRUNCATE grant (AC-MD-06; archive instead, or insert-only
-- versions), writes limited to the roles of SPEC-platform-security §4 by policy.
-- Structure only: the pilot zones (🟡 D53) come from the pilot seed (T15), never from a migration.
CREATE TABLE public.zone (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  one_way_min integer NOT NULL CHECK (one_way_min BETWEEN 1 AND 480)
);
--> statement-breakpoint
CREATE UNIQUE INDEX zone_name_unique ON public.zone (lower(name));
--> statement-breakpoint
ALTER TABLE public.zone ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.zone FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.zone FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.zone TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT ON public.zone TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY zone_read ON public.zone FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'system'));
--> statement-breakpoint
CREATE POLICY zone_insert ON public.zone FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
CREATE POLICY zone_update ON public.zone FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner')) WITH CHECK (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
SELECT audit.attach('public.zone');
