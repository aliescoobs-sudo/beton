-- ledger L33 (DECISIONS 81, owner's brief 2026-10-24): the opening state. The app starts in the middle of real activity:
-- the opening date is entered once (a singleton row), then the owner enters what clients owe us and what we owe
-- suppliers on that date. Cash and bank opening balances are L8; instruments and plans already running are entered with
-- their real past dates through the normal services. Owner writes, owner and support read, insert-only, audited.
CREATE TABLE public.ledger_opening (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  opening_date date NOT NULL,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.opening_party_balance (
  id              uuid PRIMARY KEY,
  client_id       uuid UNIQUE REFERENCES public.client (id),
  supplier_id     uuid UNIQUE REFERENCES public.supplier (id),
  -- What is owed on the opening date: by the client to us, or by us to the supplier. Always positive.
  amount_centimes bigint NOT NULL CHECK (amount_centimes > 0),
  reference       text   CHECK (reference = btrim(reference) AND length(reference) BETWEEN 1 AND 200),
  created_by      uuid   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((client_id IS NULL) <> (supplier_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE public.ledger_opening ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ledger_opening FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.opening_party_balance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.opening_party_balance FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.ledger_opening, public.opening_party_balance FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.ledger_opening, public.opening_party_balance TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY ledger_opening_definer_read ON public.ledger_opening FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY ledger_opening_read ON public.ledger_opening FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY ledger_opening_insert ON public.ledger_opening FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY opening_party_balance_read ON public.opening_party_balance FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY opening_party_balance_insert ON public.opening_party_balance FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.ledger_opening');
--> statement-breakpoint
SELECT public.grant_support_read('public.opening_party_balance');
--> statement-breakpoint
SELECT audit.attach('public.ledger_opening');
--> statement-breakpoint
SELECT audit.attach('public.opening_party_balance');
--> statement-breakpoint

-- A party balance needs the opening date first, and an active party.
CREATE FUNCTION public.opening_party_balance_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_opening) THEN
    RAISE EXCEPTION 'opening_party_balance: enter the opening date first' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client c WHERE c.id = NEW.client_id AND c.status = 'active') THEN
    RAISE EXCEPTION 'opening_party_balance: the client is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier s WHERE s.id = NEW.supplier_id AND s.status = 'active') THEN
    RAISE EXCEPTION 'opening_party_balance: the supplier is not active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER opening_party_balance_guard BEFORE INSERT ON public.opening_party_balance
  FOR EACH ROW EXECUTE FUNCTION public.opening_party_balance_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance')
$$;
