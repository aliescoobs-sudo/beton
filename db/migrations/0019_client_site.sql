-- master-data T4 (SPEC-master-data §2): delivery sites (chantiers) of a client. Same pattern as client: FORCE RLS,
-- audit, no DELETE; plant has no access. The address is sealed (address_enc); crypto:rotate re-seals it as the
-- system actor, which may update only that column.
CREATE TABLE public.client_site (
  id          uuid PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES public.client (id),
  label       text NOT NULL CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 120),
  address_enc text,
  zone_id     uuid REFERENCES public.zone (id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX client_site_label_unique ON public.client_site (client_id, lower(label));
--> statement-breakpoint
ALTER TABLE public.client_site ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.client_site FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.client_site FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.client_site TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT ON public.client_site TO belgobeton_system;
--> statement-breakpoint
GRANT UPDATE (address_enc) ON public.client_site TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY client_site_read ON public.client_site FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'system'));
--> statement-breakpoint
CREATE POLICY client_site_insert ON public.client_site FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
CREATE POLICY client_site_update ON public.client_site FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office')) WITH CHECK (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
CREATE POLICY client_site_update_system ON public.client_site FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
-- A site never moves to another client.
CREATE FUNCTION public.client_site_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'client_site.client_id is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER client_site_guard BEFORE UPDATE ON public.client_site
  FOR EACH ROW EXECUTE FUNCTION public.client_site_guard();
--> statement-breakpoint
SELECT audit.attach('public.client_site');
