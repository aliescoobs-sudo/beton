-- master-data T6 (SPEC-master-data §2): raw-material components and the units they are bought in. Same pattern as
-- zone: FORCE RLS, audit, UPDATE but no DELETE grant (AC-MD-06), managers write, every role reads (the plant reads
-- component names on the recette; neither table holds a price).
-- Immutable once created: component.code and base_unit (thresholds and factors are expressed in it), and
-- purchase_unit.factor_to_base / component_id (prices will point at the unit; a different factor is a new unit).
CREATE TABLE public.component (
  id                  uuid PRIMARY KEY,
  code                text NOT NULL UNIQUE CHECK (code ~ '^CMP-[0-9]{2,}$'),
  name_fr             text NOT NULL CHECK (name_fr = btrim(name_fr) AND length(name_fr) BETWEEN 1 AND 80),
  name_ar             text NOT NULL CHECK (name_ar = btrim(name_ar) AND length(name_ar) BETWEEN 1 AND 80),
  base_unit           text NOT NULL CHECK (base_unit IN ('g', 'mL', 'L')),
  low_stock_threshold bigint NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX component_name_fr_unique ON public.component (lower(name_fr));
--> statement-breakpoint
CREATE TABLE public.purchase_unit (
  id             uuid PRIMARY KEY,
  component_id   uuid NOT NULL REFERENCES public.component (id),
  label          text NOT NULL CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 80),
  factor_to_base integer NOT NULL CHECK (factor_to_base > 0),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX purchase_unit_label_unique ON public.purchase_unit (component_id, lower(label));
--> statement-breakpoint
CREATE FUNCTION public.component_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'component.code is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.base_unit IS DISTINCT FROM OLD.base_unit THEN
    RAISE EXCEPTION 'component.base_unit is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER component_guard BEFORE UPDATE ON public.component
  FOR EACH ROW EXECUTE FUNCTION public.component_guard();
--> statement-breakpoint
CREATE FUNCTION public.purchase_unit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.component_id IS DISTINCT FROM OLD.component_id OR NEW.factor_to_base IS DISTINCT FROM OLD.factor_to_base THEN
    RAISE EXCEPTION 'purchase_unit.component_id and factor_to_base are immutable (create a new unit)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchase_unit_guard BEFORE UPDATE ON public.purchase_unit
  FOR EACH ROW EXECUTE FUNCTION public.purchase_unit_guard();
--> statement-breakpoint
-- The six pilot components are reference data (not fake data), seeded before RLS and audit attach so the migration
-- needs no actor. code_sequence is FORCE-RLS (only request roles write it), so the migration uses fixed codes and
-- moves the 'CMP' counter past them as table owner with its audit trigger off for that one insert (bookkeeping).
INSERT INTO public.component (id, code, name_fr, name_ar, base_unit) VALUES
  (gen_random_uuid(), 'CMP-01', 'Ciment', 'إسمنت', 'g'),
  (gen_random_uuid(), 'CMP-02', 'Sable', 'رمل', 'g'),
  (gen_random_uuid(), 'CMP-03', 'Gravette 8/15', 'حصى 8/15', 'g'),
  (gen_random_uuid(), 'CMP-04', 'Gravette 15/25', 'حصى 15/25', 'g'),
  (gen_random_uuid(), 'CMP-05', 'Eau', 'ماء', 'L'),
  (gen_random_uuid(), 'CMP-06', 'Adjuvant', 'مادة مضافة', 'mL');
--> statement-breakpoint
ALTER TABLE public.code_sequence NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.code_sequence DISABLE TRIGGER USER;
--> statement-breakpoint
INSERT INTO public.code_sequence (key, last_value) VALUES ('CMP', 6);
--> statement-breakpoint
ALTER TABLE public.code_sequence ENABLE TRIGGER USER;
--> statement-breakpoint
ALTER TABLE public.code_sequence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO public.purchase_unit (id, component_id, label, factor_to_base)
SELECT gen_random_uuid(), c.id, v.label, v.factor
FROM (VALUES
  ('Ciment', 't', 1000000), ('Ciment', 'sac 50 kg', 50000),
  ('Sable', 't', 1000000), ('Gravette 8/15', 't', 1000000), ('Gravette 15/25', 't', 1000000),
  ('Eau', 'm³', 1000), ('Adjuvant', 'L', 1000)
) AS v (name_fr, label, factor)
JOIN public.component c ON lower(c.name_fr) = lower(v.name_fr)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['component', 'purchase_unit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO belgobeton_app', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_system', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app, belgobeton_system USING (ctx.role() IN (''owner'', ''partner'', ''office'', ''plant'', ''system''))',
      t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN (''owner'', ''partner'') AND status = ''active'')',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO belgobeton_app USING (ctx.role() IN (''owner'', ''partner'')) WITH CHECK (ctx.role() IN (''owner'', ''partner''))',
      t || '_update', t);
  END LOOP;
END $$;
--> statement-breakpoint
SELECT audit.attach('public.component');
--> statement-breakpoint
SELECT audit.attach('public.purchase_unit');
