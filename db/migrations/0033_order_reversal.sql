-- ledger L5 (plan decision 4, R12): the reversal pattern. An order is never edited or deleted: the owner cancels it with a
-- reversing `sales_order` row (negated volume and totals, same client, type, price, VAT and dates, mandatory reason) and
-- negated plan items (reverses_id on each). One reversal per original (UNIQUE reverses_id), a reversal cannot be reversed.
-- Only the owner reverses (DECISIONS 81): office files a correction request instead (L5b).

CREATE OR REPLACE FUNCTION public.sales_order_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_price  record;
  v_res    record;
  v_orig   public.sales_order%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.sales_order o WHERE o.id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sales_order: unknown order to reverse' USING ERRCODE = 'check_violation';
    END IF;
    IF v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'sales_order: a reversal cannot be reversed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.client_id <> v_orig.client_id OR NEW.concrete_type_id <> v_orig.concrete_type_id
       OR NEW.site_id IS DISTINCT FROM v_orig.site_id OR NEW.zone_id IS DISTINCT FROM v_orig.zone_id
       OR NEW.order_date <> v_orig.order_date OR NEW.delivery_date <> v_orig.delivery_date
       OR NEW.selling_price_id <> v_orig.selling_price_id OR NEW.unit_price_ht_centimes <> v_orig.unit_price_ht_centimes
       OR NEW.vat_rate_bp <> v_orig.vat_rate_bp OR NEW.volume_l <> -v_orig.volume_l
       OR NEW.total_ht_centimes <> -v_orig.total_ht_centimes OR NEW.total_vat_centimes <> -v_orig.total_vat_centimes
       OR NEW.total_ttc_centimes <> -v_orig.total_ttc_centimes THEN
      RAISE EXCEPTION 'sales_order: a reversal negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT c.status INTO v_status FROM public.client c WHERE c.id = NEW.client_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'sales_order: the client is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_site s WHERE s.id = NEW.site_id AND s.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION 'sales_order: the site does not belong to the client' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.status INTO v_status FROM public.concrete_type t WHERE t.id = NEW.concrete_type_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'sales_order: the concrete type is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sp.concrete_type_id, sp.price_ht_per_m3_centimes AS price INTO v_price
    FROM public.selling_price sp WHERE sp.id = NEW.selling_price_id;
  IF NOT FOUND OR v_price.concrete_type_id <> NEW.concrete_type_id THEN
    RAISE EXCEPTION 'sales_order: unknown price for this concrete type' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reason IS NULL THEN
    SELECT r.id, r.price_ht_per_m3_centimes AS price INTO v_res
      FROM public.resolve_selling_price(NEW.concrete_type_id, NEW.client_id, NEW.order_date) r;
    IF v_res.id IS DISTINCT FROM NEW.selling_price_id OR v_price.price <> NEW.unit_price_ht_centimes THEN
      RAISE EXCEPTION 'sales_order: the price is not the one in force on %', NEW.order_date USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.brought_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."user" u WHERE u.id = NEW.brought_by_user_id::text AND u.role IN ('owner', 'partner')
  ) THEN
    RAISE EXCEPTION 'sales_order: brought_by must be the owner or the partner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.payment_plan_item_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_orig public.payment_plan_item%ROWTYPE;
BEGIN
  IF NEW.direction <> 'in' THEN
    RAISE EXCEPTION 'payment_plan_item: an order item is incoming' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.payment_plan_item i WHERE i.id = NEW.reverses_id;
    IF NOT FOUND OR v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment_plan_item: a reversal item reverses an original item' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.sales_order o WHERE o.id = NEW.order_id AND o.reverses_id = v_orig.order_id
    ) THEN
      RAISE EXCEPTION 'payment_plan_item: a reversal item belongs to the reversal of its original order'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_centimes <> -v_orig.amount_centimes OR NEW.method <> v_orig.method OR NEW.due_date <> v_orig.due_date THEN
      RAISE EXCEPTION 'payment_plan_item: a reversal item negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Policies: office keeps the plain insert; the owner alone inserts reversals (with their reason).
DROP POLICY sales_order_insert ON public.sales_order;
--> statement-breakpoint
CREATE POLICY sales_order_insert ON public.sales_order FOR INSERT TO belgobeton_app
  WITH CHECK (
    created_by = ctx.user_id() AND (
      (ctx.role() IN ('owner', 'office') AND reverses_id IS NULL AND reason IS NULL)
      OR (ctx.role() = 'owner' AND reverses_id IS NOT NULL AND reason IS NOT NULL)
    )
  );
--> statement-breakpoint
DROP POLICY payment_plan_item_insert ON public.payment_plan_item;
--> statement-breakpoint
CREATE POLICY payment_plan_item_insert ON public.payment_plan_item FOR INSERT TO belgobeton_app
  WITH CHECK (
    created_by = ctx.user_id() AND direction = 'in' AND (
      (ctx.role() IN ('owner', 'office') AND reverses_id IS NULL)
      OR (ctx.role() = 'owner' AND reverses_id IS NOT NULL)
    )
  );
--> statement-breakpoint

-- Derived, never stored: an order is reversed when a reversal row points at it.
CREATE OR REPLACE VIEW public.sales_order_ops AS
  SELECT o.id, o.code, o.concrete_type_id, o.volume_l, o.delivery_date, o.zone_id, o.site_id,
         c.code AS client_code, s.label AS site_label, o.reverses_id,
         EXISTS (SELECT 1 FROM public.sales_order r WHERE r.reverses_id = o.id) AS is_reversed
    FROM public.sales_order o
    JOIN public.client c ON c.id = o.client_id
    LEFT JOIN public.client_site s ON s.id = o.site_id
   WHERE ctx.role() IN ('owner', 'support', 'partner', 'plant');
