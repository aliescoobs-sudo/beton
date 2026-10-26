-- integration I1.2 (SPEC-integration AC-INT-02, 03, 04): the scan of a signed BL. The database keeps who, what and when; the
-- bytes are sealed in the file store under the same id (src/lib/files). One scan per BL, insert-only, only on a BL whose signed
-- return is recorded. Not money: every role that reads loads reads it; plant, office, owner and partner add it (deliveries.bl_return).
CREATE TABLE public.delivery_file (
  -- Also the name of the sealed file in the store.
  id           uuid PRIMARY KEY,
  delivery_id  uuid NOT NULL UNIQUE REFERENCES public.delivery (id),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0),
  -- SHA-256 of what was stored (after the metadata was removed), to show the file was not swapped.
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.delivery_file ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_file FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.delivery_file FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.delivery_file TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY delivery_file_read ON public.delivery_file FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant'));
--> statement-breakpoint
CREATE POLICY delivery_file_insert ON public.delivery_file FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'office', 'plant') AND uploaded_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.delivery_file');
--> statement-breakpoint
SELECT audit.attach('public.delivery_file');
--> statement-breakpoint

-- The guard below reads the signed return as the migrator (SECURITY DEFINER).
CREATE POLICY delivery_return_definer_read ON public.delivery_return FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- The scan goes with a signed return of a live load: the return is recorded first (or in the same transaction).
CREATE FUNCTION public.delivery_file_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.delivery%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM public.delivery WHERE id = NEW.delivery_id;
  IF NOT FOUND OR v_d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery c WHERE c.reverses_id = v_d.id) THEN
    RAISE EXCEPTION 'delivery_file: not a live load' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.delivery_return r WHERE r.delivery_id = NEW.delivery_id) THEN
    RAISE EXCEPTION 'delivery_file: the signed return is not recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_file_guard BEFORE INSERT ON public.delivery_file
  FOR EACH ROW EXECUTE FUNCTION public.delivery_file_guard();
--> statement-breakpoint

-- The size limit of an uploaded document is a parameter the roles that upload may read (they cannot read the parameter table).
CREATE OR REPLACE FUNCTION public.ops_parameter(p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant', 'support', 'system') THEN
    RAISE EXCEPTION 'ops_parameter: role % may not read parameters', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key NOT IN ('concrete_limit_min', 'unloading_min', 'load_excess_tolerance_bp', 'loading_min', 'return_extra_min',
                   'working_min', 'day_start_min', 'default_one_way_min', 'consumption_tolerance_bp',
                   'reorder_margin_days', 'upload_max_bytes') THEN
    RAISE EXCEPTION 'ops_parameter: % is not an operations parameter', p_key USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT p.value FROM public.parameter p WHERE p.key = p_key);
END $$;
