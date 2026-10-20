-- master-data T8 (SPEC-master-data §2, AC-MD-02): recettes are versioned and never edited in place. Both tables are
-- insert-only (no UPDATE, DELETE or TRUNCATE grant); a change is a new version with its own effective_from.
-- Orders store the resolved recette id, so a later version never changes a past document.
CREATE TABLE public.recette (
  id               uuid PRIMARY KEY,
  concrete_type_id uuid NOT NULL REFERENCES public.concrete_type (id),
  version          integer NOT NULL CHECK (version >= 1),
  effective_from   date NOT NULL,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (concrete_type_id, version),
  UNIQUE (concrete_type_id, effective_from)
);
--> statement-breakpoint
CREATE TABLE public.recette_line (
  id           uuid PRIMARY KEY,
  recette_id   uuid NOT NULL REFERENCES public.recette (id),
  component_id uuid NOT NULL REFERENCES public.component (id),
  -- Base units of the component per m³ of concrete: an integer, never a decimal.
  qty_per_m3   bigint NOT NULL CHECK (qty_per_m3 > 0),
  UNIQUE (recette_id, component_id)
);
--> statement-breakpoint
-- Versions are consecutive and strictly later in time; the advisory lock serializes two managers on one type.
CREATE FUNCTION public.recette_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_version integer;
  v_last    date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.concrete_type_id::text, 0));
  SELECT coalesce(max(version), 0), max(effective_from) INTO v_version, v_last
    FROM public.recette WHERE concrete_type_id = NEW.concrete_type_id;
  IF NEW.version <> v_version + 1 THEN
    RAISE EXCEPTION 'recette: version conflict, retry' USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_last IS NOT NULL AND NEW.effective_from <= v_last THEN
    RAISE EXCEPTION 'recette: effective_from must be after the previous version (%)', v_last
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER recette_guard BEFORE INSERT ON public.recette
  FOR EACH ROW EXECUTE FUNCTION public.recette_guard();
--> statement-breakpoint
-- Lines can only be added in the transaction that created their recette: a published version stays sealed.
CREATE FUNCTION public.recette_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.recette r WHERE r.id = NEW.recette_id AND r.created_at = now()) THEN
    RAISE EXCEPTION 'recette_line: a published recette is sealed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER recette_line_guard BEFORE INSERT ON public.recette_line
  FOR EACH ROW EXECUTE FUNCTION public.recette_line_guard();
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recette', 'recette_line'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO belgobeton_app', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_system', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app, belgobeton_system USING (ctx.role() IN (''owner'', ''partner'', ''office'', ''plant'', ''system''))',
      t || '_read', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY recette_insert ON public.recette FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY recette_line_insert ON public.recette_line FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner'));
--> statement-breakpoint
SELECT audit.attach('public.recette');
--> statement-breakpoint
SELECT audit.attach('public.recette_line');
