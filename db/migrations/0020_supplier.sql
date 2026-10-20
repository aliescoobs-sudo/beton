-- master-data T5 (SPEC-master-data §2): suppliers, same pattern as client (FORCE RLS, audit, no DELETE, archive by
-- owner/partner only, immutable code, sealed phone). No ICE override here: a second supplier on the same ICE is
-- simply refused.
CREATE TABLE public.supplier (
  id                 uuid PRIMARY KEY,
  code               text NOT NULL UNIQUE CHECK (code ~ '^FRN-[0-9]{2,}$'),
  name               text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  category           text NOT NULL CHECK (category IN ('cement', 'aggregates', 'admixture', 'transport', 'fuel', 'other')),
  ice                text CHECK (ice ~ '^[0-9]{15}$'),
  phone_enc          text,
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX supplier_ice_unique ON public.supplier (ice) WHERE ice IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.supplier ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.supplier FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.supplier FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.supplier TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT ON public.supplier TO belgobeton_system;
--> statement-breakpoint
GRANT UPDATE (phone_enc) ON public.supplier TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY supplier_read ON public.supplier FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'system'));
--> statement-breakpoint
CREATE POLICY supplier_insert ON public.supplier FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'office') AND status = 'active');
--> statement-breakpoint
CREATE POLICY supplier_update ON public.supplier FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office')) WITH CHECK (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
CREATE POLICY supplier_update_system ON public.supplier FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
CREATE FUNCTION public.supplier_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'supplier.code is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND ctx.role() NOT IN ('owner', 'partner') THEN
    RAISE EXCEPTION 'supplier: only owner or partner may archive' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER supplier_guard BEFORE UPDATE ON public.supplier
  FOR EACH ROW EXECUTE FUNCTION public.supplier_guard();
--> statement-breakpoint
SELECT audit.attach('public.supplier');
