-- master-data T7 (SPEC-master-data §2): concrete types (B20, B25...). Same pattern as component: FORCE RLS, audit,
-- no DELETE (archive instead; an archived type stays readable but is not selectable), managers write, office and
-- plant read. The code is typed by a manager (it is the product's name) and never changes.
-- Structure only (decision 79): B12/B20/B25/B30 come from the pilot seed.
CREATE TABLE public.concrete_type (
  id     uuid PRIMARY KEY,
  code   text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9]{1,9}$'),
  label  text NOT NULL CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE FUNCTION public.concrete_type_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'concrete_type.code is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER concrete_type_guard BEFORE UPDATE ON public.concrete_type
  FOR EACH ROW EXECUTE FUNCTION public.concrete_type_guard();
--> statement-breakpoint
ALTER TABLE public.concrete_type ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.concrete_type FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.concrete_type FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.concrete_type TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT ON public.concrete_type TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY concrete_type_read ON public.concrete_type FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'system'));
--> statement-breakpoint
CREATE POLICY concrete_type_insert ON public.concrete_type FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND status = 'active');
--> statement-breakpoint
CREATE POLICY concrete_type_update ON public.concrete_type FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner')) WITH CHECK (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
GRANT INSERT ON public.concrete_type TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY concrete_type_insert_system ON public.concrete_type FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system' AND status = 'active');
--> statement-breakpoint
SELECT audit.attach('public.concrete_type');
