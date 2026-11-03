-- C3 (REQUIREMENTS-V1 §16.7): receipt states. A delivery is: ordered, physically arrived, available for production, documented
-- (accepted on paper by the office). The plant records what physically arrived per purchase line, how much it refused, and whether
-- it may be used now; the weighbridge ticket or the delivery note is attached. Stock then shows two figures: what is booked, and
-- what arrived and can be used before the office has finished the paperwork. Quantities only, never a price.
-- Quantities are thousandths of the purchase unit, like the purchase line and the receipt line.
CREATE TABLE public.receipt_arrival_line (
  id               uuid PRIMARY KEY,
  confirmation_id  uuid    NOT NULL REFERENCES public.receipt_plant_confirmation (id),
  purchase_line_id uuid    NOT NULL REFERENCES public.purchase_line (id),
  plant_id         uuid REFERENCES public.plant (id),
  -- Physically arrived, of which refused (damaged, wrong grade...). The usable quantity is arrived minus rejected.
  arrived_milli    bigint  NOT NULL CHECK (arrived_milli >= 0),
  rejected_milli   bigint  NOT NULL DEFAULT 0 CHECK (rejected_milli >= 0),
  -- The plant may produce with it now (sample checked, silo ready), before the office documents the receipt.
  available        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (confirmation_id, purchase_line_id),
  CHECK (rejected_milli <= arrived_milli),
  CHECK (NOT available OR arrived_milli > rejected_milli)
);
--> statement-breakpoint
ALTER TABLE public.receipt_arrival_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.receipt_arrival_line FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.receipt_arrival_line FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.receipt_arrival_line TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY receipt_arrival_line_read ON public.receipt_arrival_line FOR SELECT TO belgobeton_app
  USING ((ctx.role() IN ('owner', 'partner', 'plant', 'support') OR ctx.actor_role() = 'office_purchases')
         AND (ctx.plant_scope() IS NULL OR plant_id IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
CREATE POLICY receipt_arrival_line_definer ON public.receipt_arrival_line FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
SELECT audit.attach('public.receipt_arrival_line');
--> statement-breakpoint
SELECT public.grant_support_read('public.receipt_arrival_line');
--> statement-breakpoint

-- The weighbridge ticket or delivery note of an arrival: metadata here, the sealed bytes in the file store (src/lib/files).
CREATE TABLE public.receipt_arrival_file (
  -- Also the name of the sealed file in the store.
  id              uuid PRIMARY KEY,
  confirmation_id uuid NOT NULL REFERENCES public.receipt_plant_confirmation (id),
  plant_id        uuid REFERENCES public.plant (id),
  kind            text NOT NULL CHECK (kind IN ('weighbridge_ticket', 'delivery_note')),
  content_type    text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes      integer NOT NULL CHECK (size_bytes > 0),
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX receipt_arrival_file_conf_idx ON public.receipt_arrival_file (confirmation_id);
--> statement-breakpoint
ALTER TABLE public.receipt_arrival_file ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.receipt_arrival_file FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.receipt_arrival_file FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.receipt_arrival_file TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY receipt_arrival_file_read ON public.receipt_arrival_file FOR SELECT TO belgobeton_app
  USING ((ctx.role() IN ('owner', 'partner', 'plant', 'support') OR ctx.actor_role() = 'office_purchases')
         AND (ctx.plant_scope() IS NULL OR plant_id IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
CREATE POLICY receipt_arrival_file_insert ON public.receipt_arrival_file FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND uploaded_by = ctx.user_id()
              AND (ctx.plant_scope() IS NULL OR plant_id IS NULL OR plant_id = ctx.plant_scope()));
--> statement-breakpoint
SELECT audit.attach('public.receipt_arrival_file');
--> statement-breakpoint
SELECT public.grant_support_read('public.receipt_arrival_file');
--> statement-breakpoint
-- At most five documents per arrival, only while the arrival is not documented, and the plant of the row is the arrival's.
CREATE FUNCTION public.receipt_arrival_file_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.receipt_plant_confirmation%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM public.receipt_plant_confirmation WHERE id = NEW.confirmation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'receipt_arrival_file: unknown arrival' USING ERRCODE = 'check_violation'; END IF;
  IF v_c.receipt_id IS NOT NULL THEN
    RAISE EXCEPTION 'receipt_arrival_file: the arrival is already documented' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM public.receipt_arrival_file f WHERE f.confirmation_id = NEW.confirmation_id) >= 5 THEN
    RAISE EXCEPTION 'receipt_arrival_file: at most five documents per arrival' USING ERRCODE = 'check_violation';
  END IF;
  NEW.plant_id := v_c.plant_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER receipt_arrival_file_guard BEFORE INSERT ON public.receipt_arrival_file
  FOR EACH ROW EXECUTE FUNCTION public.receipt_arrival_file_guard();
--> statement-breakpoint
CREATE POLICY receipt_arrival_confirmation_definer_read ON public.receipt_plant_confirmation FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
-- Office purchases read the arrivals too: it documents what the plant counted.
DROP POLICY receipt_plant_confirmation_read ON public.receipt_plant_confirmation;
--> statement-breakpoint
CREATE POLICY receipt_plant_confirmation_read ON public.receipt_plant_confirmation FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant', 'support') OR ctx.actor_role() = 'office_purchases');
--> statement-breakpoint

-- A new kind of notification: the plant refused a quantity on a delivery.
DO $$
DECLARE v text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v FROM pg_constraint c WHERE c.conrelid = 'public.notification'::regclass AND c.conname = 'notification_kind_check';
  IF position('''test''::text' IN v) = 0 THEN RAISE EXCEPTION 'notification_kind_check changed shape'; END IF;
  ALTER TABLE public.notification DROP CONSTRAINT notification_kind_check;
  EXECUTE 'ALTER TABLE public.notification ADD CONSTRAINT notification_kind_check ' || replace(v, '''test''::text', '''test''::text, ''receipt_rejected''::text');
END $$;
--> statement-breakpoint
-- The plant confirms an arrival WITH its quantities. The old door (no lines) stays for an arrival counted later.
-- p_lines: [{"line": uuid, "arrived": milli, "rejected": milli, "available": bool}]
CREATE FUNCTION public.confirm_receipt_at_plant_lines(p_purchase uuid, p_note text, p_lines jsonb) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
  v_plant uuid;
  r record;
  v_n integer := 0;
BEGIN
  v_id := public.confirm_receipt_at_plant(p_purchase, p_note);
  SELECT c.plant_id INTO v_plant FROM public.receipt_plant_confirmation c WHERE c.id = v_id;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN RETURN v_id; END IF;
  FOR r IN SELECT x.line, x.arrived, coalesce(x.rejected, 0) AS rejected, coalesce(x.available, false) AS available
             FROM jsonb_to_recordset(p_lines) AS x(line uuid, arrived bigint, rejected bigint, available boolean) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.purchase_line l WHERE l.id = r.line AND l.purchase_id = p_purchase AND l.component_id IS NOT NULL) THEN
      RAISE EXCEPTION 'confirm_receipt_at_plant: that line is not a stocked line of this purchase' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.receipt_arrival_line (id, confirmation_id, purchase_line_id, plant_id, arrived_milli, rejected_milli, available)
    VALUES (gen_random_uuid(), v_id, r.line, v_plant, r.arrived, r.rejected, r.available);
    v_n := v_n + 1;
  END LOOP;
  IF v_n > 0 AND EXISTS (SELECT 1 FROM public.receipt_arrival_line a WHERE a.confirmation_id = v_id AND a.rejected_milli > 0) THEN
    PERFORM public.notify('receipt_rejected', 'important', jsonb_build_object('purchase', (SELECT p.code FROM public.purchase p WHERE p.id = p_purchase)),
                          '/receipts', v_plant, ARRAY['owner', 'app_admin', 'office_purchases'], NULL);
  END IF;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.confirm_receipt_at_plant_lines(uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.confirm_receipt_at_plant_lines(uuid, text, jsonb) TO belgobeton_app;
--> statement-breakpoint

-- The state of every recent arrival, per line: ordered, arrived, refused, usable now, documented. Quantities only.
CREATE FUNCTION public.receipt_states(p_since date) RETURNS TABLE(
  confirmation_id uuid, purchase_id uuid, purchase_code text, confirmed_at timestamptz, plant_id uuid, state text, documented boolean,
  note text, files integer, line_id uuid, name_fr text, name_ar text, unit_label text,
  ordered_milli bigint, arrived_milli bigint, rejected_milli bigint, available boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'plant', 'plant_manager', 'office_purchases', 'support') THEN
    RAISE EXCEPTION 'receipt_states: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT c.id, c.purchase_id, p.code, c.confirmed_at, c.plant_id,
           CASE WHEN c.receipt_id IS NOT NULL THEN 'documented'
                WHEN EXISTS (SELECT 1 FROM public.receipt_arrival_line a WHERE a.confirmation_id = c.id AND a.available) THEN 'available'
                ELSE 'arrived' END,
           c.receipt_id IS NOT NULL, c.note,
           (SELECT count(*)::integer FROM public.receipt_arrival_file f WHERE f.confirmation_id = c.id),
           l.id, comp.name_fr, comp.name_ar, u.label, l.qty_milli,
           coalesce(a.arrived_milli, 0), coalesce(a.rejected_milli, 0), coalesce(a.available, false)
      FROM public.receipt_plant_confirmation c
      JOIN public.purchase p ON p.id = c.purchase_id
      JOIN public.purchase_line l ON l.purchase_id = p.id AND l.component_id IS NOT NULL
      JOIN public.component comp ON comp.id = l.component_id
      JOIN public.purchase_unit u ON u.id = l.purchase_unit_id
      LEFT JOIN public.receipt_arrival_line a ON a.confirmation_id = c.id AND a.purchase_line_id = l.id
     WHERE c.confirmed_at::date >= p_since
       AND (ctx.plant_scope() IS NULL OR c.plant_id IS NULL OR c.plant_id = ctx.plant_scope())
     ORDER BY c.confirmed_at DESC, p.code, l.seq;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.receipt_states(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.receipt_states(date) TO belgobeton_app;
--> statement-breakpoint

-- What arrived, is usable and is not documented yet, per component, in base units. When the office documents the receipt the
-- arrival leaves this figure and the booked stock goes up by what the office recorded (so the two never add up twice).
CREATE FUNCTION public.stock_arrived_pending(p_plant uuid) RETURNS TABLE(component_id uuid, qty_base bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'plant', 'support') THEN
    RAISE EXCEPTION 'stock_arrived_pending: role % may not read stock', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT l.component_id, sum(public.scale_qty(u.factor_to_base, a.arrived_milli - a.rejected_milli, 1000))::bigint
      FROM public.receipt_arrival_line a
      JOIN public.receipt_plant_confirmation c ON c.id = a.confirmation_id AND c.receipt_id IS NULL
      JOIN public.purchase_line l ON l.id = a.purchase_line_id
      JOIN public.purchase_unit u ON u.id = l.purchase_unit_id
     WHERE a.available AND (p_plant IS NULL OR a.plant_id = p_plant)
       AND (ctx.plant_scope() IS NULL OR a.plant_id IS NULL OR a.plant_id = ctx.plant_scope())
     GROUP BY l.component_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.stock_arrived_pending(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stock_arrived_pending(uuid) TO belgobeton_app;
