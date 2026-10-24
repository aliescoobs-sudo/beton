-- ledger L8 (DECISIONS 81): the caisse and the bank accounts, and their opening balances. Money data: the owner writes,
-- the owner and support read; office, partner and plant read nothing and write nothing. Insert-only (no UPDATE, DELETE or
-- TRUNCATE grant): an account is never edited or removed, an opening balance is set once per account (a mistake is
-- fixed by a reversing movement, L10). Accounts and balances come from the pilot seed, never from a migration (D79).
CREATE TABLE public.money_account (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('cash', 'bank')),
  label      text NOT NULL CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 80),
  bank_name  text CHECK (bank_name = btrim(bank_name) AND length(bank_name) BETWEEN 1 AND 80),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'bank' OR bank_name IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX money_account_label_idx ON public.money_account (lower(label));
--> statement-breakpoint
CREATE TABLE public.opening_balance (
  id               uuid PRIMARY KEY,
  account_id       uuid NOT NULL UNIQUE REFERENCES public.money_account (id),
  as_of            date NOT NULL,
  amount_centimes  bigint NOT NULL,
  note             text CHECK (note = btrim(note) AND length(note) BETWEEN 1 AND 500),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.money_account ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.money_account FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.opening_balance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.opening_balance FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.money_account, public.opening_balance FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.money_account, public.opening_balance TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY money_account_read ON public.money_account FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY money_account_insert ON public.money_account FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY opening_balance_read ON public.opening_balance FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY opening_balance_insert ON public.opening_balance FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.money_account');
--> statement-breakpoint
SELECT public.grant_support_read('public.opening_balance');
--> statement-breakpoint
SELECT audit.attach('public.money_account');
--> statement-breakpoint
SELECT audit.attach('public.opening_balance');
--> statement-breakpoint
-- The audit rows of an opening balance hold the amount: owner and support only.
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance')
$$;
