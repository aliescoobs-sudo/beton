-- C4.2 (REQUIREMENTS-V1 §16.7): the variance between what the plant counted and what the office documents. When the office
-- records a receipt that consumes a plant confirmation with quantities, each line is compared: usable at the plant (arrived minus
-- refused) against what the office recorded. The difference, its size in basis points of the plant's count and the threshold
-- in force are written once (insert-only); above the threshold (parameter receipt_variance_bp, default 200 = 2 %) the owner roles,
-- the office purchases and the plant manager are notified. Quantities only, thousandths of the purchase unit, never a price.
CREATE TABLE public.receipt_variance (
  id               uuid PRIMARY KEY,
  receipt_id       uuid   NOT NULL REFERENCES public.purchase_receipt (id),
  confirmation_id  uuid   NOT NULL REFERENCES public.receipt_plant_confirmation (id),
  purchase_line_id uuid   NOT NULL REFERENCES public.purchase_line (id),
  plant_id         uuid REFERENCES public.plant (id),
  plant_milli      bigint NOT NULL CHECK (plant_milli >= 0),
  office_milli     bigint NOT NULL CHECK (office_milli >= 0),
  -- Office minus plant: negative when the office documents less than the plant counted.
  variance_milli   bigint NOT NULL,
  -- |variance| in basis points of the plant's count; 1 000 000 when the plant counted nothing usable and the office recorded some.
  variance_bp      bigint NOT NULL CHECK (variance_bp >= 0),
  threshold_bp     integer NOT NULL CHECK (threshold_bp >= 0),
  over_threshold   boolean NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, purchase_line_id),
  CHECK (variance_milli = office_milli - plant_milli)
);
--> statement-breakpoint
CREATE INDEX receipt_variance_conf_idx ON public.receipt_variance (confirmation_id);
--> statement-breakpoint
ALTER TABLE public.receipt_variance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.receipt_variance FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.receipt_variance FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.receipt_variance TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY receipt_variance_read ON public.receipt_variance FOR SELECT TO belgobeton_app
  USING ((ctx.role() IN ('owner', 'partner', 'plant', 'support') OR ctx.actor_role() = 'office_purchases')
         AND (ctx.plant_scope() IS NULL OR plant_id IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
CREATE POLICY receipt_variance_definer ON public.receipt_variance FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
SELECT audit.attach('public.receipt_variance');
--> statement-breakpoint
SELECT public.grant_support_read('public.receipt_variance');
--> statement-breakpoint
-- insert-only, as the receipts themselves
CREATE FUNCTION public.receipt_variance_sealed() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'receipt_variance is insert-only' USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER receipt_variance_sealed BEFORE UPDATE OR DELETE ON public.receipt_variance
  FOR EACH ROW EXECUTE FUNCTION public.receipt_variance_sealed();
--> statement-breakpoint

DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v FROM pg_constraint c WHERE c.conrelid = 'public.notification'::regclass AND c.conname = 'notification_kind_check';
  IF position('''test''::text' IN v) = 0 THEN RAISE EXCEPTION 'notification_kind_check changed shape'; END IF;
  ALTER TABLE public.notification DROP CONSTRAINT notification_kind_check;
  EXECUTE 'ALTER TABLE public.notification ADD CONSTRAINT notification_kind_check ' || replace(v, '''test''::text', '''test''::text, ''receipt_variance''::text');
END $$;
--> statement-breakpoint

-- The office's door gains the comparison (the plant-rule wrapper of 0078, renamed __inner by 0082, which keeps its role deny wrapper in front), after the core has written the receipt and before the confirmation is closed.
CREATE OR REPLACE FUNCTION public.record_receipt_lines__inner(p_purchase uuid, p_date date, p_lines jsonb, p_confirm_excess boolean)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id   uuid;
  v_conf uuid;
  v_plant uuid;
  v_th   integer;
  v_over integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.plant p WHERE p.status = 'active') THEN
    IF ctx.role() = 'plant' THEN
      RAISE EXCEPTION 'record_receipt: the plant confirms the arrival; the office records the receipt'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT c.id, c.plant_id INTO v_conf, v_plant FROM public.receipt_plant_confirmation c
     WHERE c.purchase_id = p_purchase AND c.receipt_id IS NULL ORDER BY c.confirmed_at LIMIT 1 FOR UPDATE;
    IF v_conf IS NULL THEN
      RAISE EXCEPTION 'record_receipt: the plant has not confirmed this arrival' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_id := public.record_receipt_lines_core(p_purchase, p_date, p_lines, p_confirm_excess);
  IF v_conf IS NOT NULL THEN
    UPDATE public.receipt_plant_confirmation SET receipt_id = v_id WHERE id = v_conf;
    SELECT coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'receipt_variance_bp'), 200)
      INTO v_th;
    WITH c AS (
      SELECT a.purchase_line_id, a.arrived_milli - a.rejected_milli AS plant_m, coalesce(rl.qty_milli, 0) AS office_m
        FROM public.receipt_arrival_line a
        LEFT JOIN public.purchase_receipt_line rl ON rl.receipt_id = v_id AND rl.purchase_line_id = a.purchase_line_id
       WHERE a.confirmation_id = v_conf
    ), d AS (
      SELECT c.*, CASE WHEN c.plant_m = 0 THEN (CASE WHEN c.office_m = 0 THEN 0 ELSE 1000000 END)
                       ELSE abs(c.office_m - c.plant_m) * 10000 / c.plant_m END AS bp
        FROM c
    ), ins AS (
      INSERT INTO public.receipt_variance (id, receipt_id, confirmation_id, purchase_line_id, plant_id, plant_milli, office_milli,
                                           variance_milli, variance_bp, threshold_bp, over_threshold)
      SELECT gen_random_uuid(), v_id, v_conf, d.purchase_line_id, v_plant, d.plant_m, d.office_m, d.office_m - d.plant_m, d.bp, v_th,
             d.bp > v_th
        FROM d
      RETURNING over_threshold
    )
    SELECT count(*) FILTER (WHERE over_threshold) INTO v_over FROM ins;
    IF v_over > 0 THEN
      PERFORM public.notify('receipt_variance', 'important',
                            jsonb_build_object('purchase', (SELECT p.code FROM public.purchase p WHERE p.id = p_purchase)),
                            '/receipts', v_plant, ARRAY['owner', 'app_admin', 'office_purchases', 'plant_manager'], NULL);
    END IF;
  END IF;
  RETURN v_id;
END $$;
