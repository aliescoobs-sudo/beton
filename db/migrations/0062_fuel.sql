-- operations O13 (SPEC-operations §7.2, AC-OPS-22): fuel per truck.
-- fuel_fill: litres put in a truck (from our tank or at a station), with the odometer when it was read. Quantities only: the
-- plant, owner and partner record and read them. Insert-only; a correction is a new row read next to it.
-- fuel_purchase: fuel bought (litres and the total paid). MONEY: the owner writes it, the owner and support read it, nobody
-- else (money_visibility); its audit rows are hidden from the others (audit.is_money_table). The price per litre and the cost
-- of a truck's fuel are computed by deterministic code from it and are never stored.
CREATE TABLE public.fuel_fill (
  id         uuid PRIMARY KEY,
  truck_id   uuid NOT NULL REFERENCES public.truck (id),
  filled_on  date NOT NULL,
  -- Millilitres, an integer like every quantity.
  litres_ml  integer NOT NULL CHECK (litres_ml BETWEEN 1000 AND 2000000),
  odometer_km integer CHECK (odometer_km IS NULL OR odometer_km BETWEEN 0 AND 5000000),
  source     text NOT NULL DEFAULT 'tank' CHECK (source IN ('tank', 'station')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX fuel_fill_truck_idx ON public.fuel_fill (truck_id, filled_on);
--> statement-breakpoint
ALTER TABLE public.fuel_fill ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.fuel_fill FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.fuel_fill FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.fuel_fill TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY fuel_fill_read ON public.fuel_fill FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY fuel_fill_insert ON public.fuel_fill FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'plant') AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.fuel_fill');
--> statement-breakpoint
SELECT audit.attach('public.fuel_fill');
--> statement-breakpoint

-- A truck's odometer never goes back: a reading lower than an earlier fill's is refused (a typing error is a new, higher row).
CREATE FUNCTION public.fuel_fill_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fuel_fill:' || NEW.truck_id::text, 0));
  IF NEW.odometer_km IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.fuel_fill f
        WHERE f.truck_id = NEW.truck_id AND f.odometer_km IS NOT NULL AND f.filled_on <= NEW.filled_on
          AND f.odometer_km > NEW.odometer_km) THEN
    RAISE EXCEPTION 'fuel_fill: the odometer is lower than an earlier reading' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE POLICY fuel_fill_definer_read ON public.fuel_fill FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE TRIGGER fuel_fill_guard BEFORE INSERT ON public.fuel_fill
  FOR EACH ROW EXECUTE FUNCTION public.fuel_fill_guard();
--> statement-breakpoint

CREATE TABLE public.fuel_purchase (
  id              uuid PRIMARY KEY,
  purchased_on    date NOT NULL,
  litres_ml       integer NOT NULL CHECK (litres_ml BETWEEN 1000 AND 100000000),
  -- Centimes, VAT included as paid.
  total_centimes  bigint NOT NULL CHECK (total_centimes > 0),
  supplier_id     uuid REFERENCES public.supplier (id),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.fuel_purchase ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.fuel_purchase FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.fuel_purchase FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.fuel_purchase TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY fuel_purchase_read ON public.fuel_purchase FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY fuel_purchase_insert ON public.fuel_purchase FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.fuel_purchase');
--> statement-breakpoint
SELECT audit.attach('public.fuel_purchase');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line', 'quote',
                     'alert', 'alert_event', 'cash_decision', 'fuel_purchase')
$$;
