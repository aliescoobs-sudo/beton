-- master-data T11 (SPEC-master-data §2, AC-MD-03): selling prices per m³ HT, versioned and never edited in place.
-- Insert-only (no UPDATE, DELETE or TRUNCATE grant). client_id NULL = the list price of a concrete type; a client_id is
-- a per-client override (T12 adds the override policy and the reason CHECK; until then only list prices can be written).
-- Owner/partner write; office reads; plant has no access.
CREATE TABLE public.selling_price (
  id                       uuid PRIMARY KEY,
  concrete_type_id         uuid NOT NULL REFERENCES public.concrete_type (id),
  client_id                uuid REFERENCES public.client (id),
  -- Centimes HT per m³: an integer, never a decimal.
  price_ht_per_m3_centimes bigint NOT NULL CHECK (price_ht_per_m3_centimes > 0),
  effective_from           date NOT NULL,
  reason                   text CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by               uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (concrete_type_id, client_id, effective_from)
);
--> statement-breakpoint
-- Versions of one (type, client) scope are strictly increasing in time, so a price already used for a past date can
-- never be shadowed by a back-dated one. The advisory lock serializes two managers on one scope.
CREATE FUNCTION public.selling_price_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_last date;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.concrete_type_id::text || ':' || coalesce(NEW.client_id::text, 'list'), 2));
  SELECT max(effective_from) INTO v_last FROM public.selling_price
   WHERE concrete_type_id = NEW.concrete_type_id AND client_id IS NOT DISTINCT FROM NEW.client_id;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'selling_price: effective_from must be after the previous version (%)', v_last
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER selling_price_guard BEFORE INSERT ON public.selling_price
  FOR EACH ROW EXECUTE FUNCTION public.selling_price_guard();
--> statement-breakpoint
ALTER TABLE public.selling_price ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.selling_price FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.selling_price FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.selling_price TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY selling_price_read ON public.selling_price FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
CREATE POLICY selling_price_list_insert ON public.selling_price FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND client_id IS NULL AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT audit.attach('public.selling_price');
