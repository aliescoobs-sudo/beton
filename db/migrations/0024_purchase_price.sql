-- master-data T10 (SPEC-master-data §2, AC-MD-04/07): purchase prices are versioned and never edited in place. Insert-only
-- (no UPDATE, DELETE or TRUNCATE grant): a new price is a new row with a later effective_from. The cost of a component per
-- m³ is computed from these rows and the recette, never stored.
-- Owner/partner write; office reads (the purchases it enters); plant has no access at all.
CREATE TABLE public.purchase_price (
  id                uuid PRIMARY KEY,
  component_id      uuid NOT NULL REFERENCES public.component (id),
  supplier_id       uuid NOT NULL REFERENCES public.supplier (id),
  purchase_unit_id  uuid NOT NULL REFERENCES public.purchase_unit (id),
  -- Centimes HT per purchase unit: an integer, never a decimal.
  price_ht_centimes bigint NOT NULL CHECK (price_ht_centimes > 0),
  effective_from    date NOT NULL,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (component_id, effective_from)
);
--> statement-breakpoint
-- The unit must belong to the component, and versions of one component are strictly increasing in time, so a price
-- already used for a past date can never be shadowed by a back-dated one. The advisory lock serializes two managers.
CREATE FUNCTION public.purchase_price_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_last date;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.purchase_unit u WHERE u.id = NEW.purchase_unit_id AND u.component_id = NEW.component_id
  ) THEN
    RAISE EXCEPTION 'purchase_price: the unit does not belong to the component' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.component_id::text, 1));
  SELECT max(effective_from) INTO v_last FROM public.purchase_price WHERE component_id = NEW.component_id;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'purchase_price: effective_from must be after the previous version (%)', v_last
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_price_guard BEFORE INSERT ON public.purchase_price
  FOR EACH ROW EXECUTE FUNCTION public.purchase_price_guard();
--> statement-breakpoint
ALTER TABLE public.purchase_price ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.purchase_price FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.purchase_price FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.purchase_price TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY purchase_price_read ON public.purchase_price FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
CREATE POLICY purchase_price_insert ON public.purchase_price FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT audit.attach('public.purchase_price');
