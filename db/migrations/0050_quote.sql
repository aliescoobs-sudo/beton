-- ledger L31 (AC-LED-23, DECISIONS 82): quotes (devis). A quote prices a volume of concrete for a client at the price in force
-- and is valid until a date; it has no payment plan and no ledger effect. Insert-only, DV-YYYY-nnnnn from the document counter.
-- Owner and office create (office blind, the price resolved by the database); owner and support read and print.
-- "Convert to order" is a human saving the order form prefilled from the quote: the order then carries `quote_id`, so a
-- quote is "converted" when an order points at it (derived, nothing is updated).

CREATE TABLE public.quote (
  id               uuid PRIMARY KEY,
  code             text   NOT NULL UNIQUE CHECK (code ~ '^DV-[0-9]{4}-[0-9]{5,}$'),
  client_id        uuid   NOT NULL REFERENCES public.client (id),
  concrete_type_id uuid   NOT NULL REFERENCES public.concrete_type (id),
  volume_l         integer NOT NULL CHECK (volume_l > 0),
  quote_date       date   NOT NULL,
  valid_until      date   NOT NULL,
  selling_price_id uuid   NOT NULL REFERENCES public.selling_price (id),
  unit_price_ht_centimes bigint NOT NULL CHECK (unit_price_ht_centimes > 0),
  vat_rate_bp      integer NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  total_ht_centimes  bigint NOT NULL CHECK (total_ht_centimes > 0),
  total_vat_centimes bigint NOT NULL,
  total_ttc_centimes bigint NOT NULL,
  created_by       uuid   NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (total_ttc_centimes = total_ht_centimes + total_vat_centimes),
  CHECK (valid_until >= quote_date)
);
--> statement-breakpoint
CREATE INDEX quote_client_idx ON public.quote (client_id);
--> statement-breakpoint
CREATE POLICY quote_definer_read ON public.quote FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- Guard: an active client and type, and the price in force on the quote date (a quote never carries another price; a
-- different price is the owner's decision when the order is saved).
CREATE FUNCTION public.quote_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_price  record;
  v_res    record;
BEGIN
  SELECT c.status INTO v_status FROM public.client c WHERE c.id = NEW.client_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'quote: the client is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.status INTO v_status FROM public.concrete_type t WHERE t.id = NEW.concrete_type_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'quote: the concrete type is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sp.concrete_type_id, sp.price_ht_per_m3_centimes AS price INTO v_price
    FROM public.selling_price sp WHERE sp.id = NEW.selling_price_id;
  IF NOT FOUND OR v_price.concrete_type_id <> NEW.concrete_type_id THEN
    RAISE EXCEPTION 'quote: unknown price for this concrete type' USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.id, r.price_ht_per_m3_centimes AS price INTO v_res
    FROM public.resolve_selling_price(NEW.concrete_type_id, NEW.client_id, NEW.quote_date) r;
  IF v_res.id IS DISTINCT FROM NEW.selling_price_id OR v_price.price <> NEW.unit_price_ht_centimes THEN
    RAISE EXCEPTION 'quote: the price is not the one in force on %', NEW.quote_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER quote_guard BEFORE INSERT ON public.quote
  FOR EACH ROW EXECUTE FUNCTION public.quote_guard();
--> statement-breakpoint
ALTER TABLE public.quote ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.quote FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.quote FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.quote TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY quote_read ON public.quote FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY quote_insert ON public.quote FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'office') AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.quote');
--> statement-breakpoint
SELECT audit.attach('public.quote');
--> statement-breakpoint

-- An order made from a quote points at it, once, for the same client and type.
ALTER TABLE public.sales_order ADD COLUMN quote_id uuid UNIQUE REFERENCES public.quote (id);
--> statement-breakpoint
CREATE FUNCTION public.sales_order_quote_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.quote_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.quote q WHERE q.id = NEW.quote_id AND q.client_id = NEW.client_id AND q.concrete_type_id = NEW.concrete_type_id
  ) THEN
    RAISE EXCEPTION 'sales_order: not the client and type of the quote' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_order_quote_guard BEFORE INSERT ON public.sales_order
  FOR EACH ROW EXECUTE FUNCTION public.sales_order_quote_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line', 'quote')
$$;
