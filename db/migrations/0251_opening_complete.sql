-- T19-close A (D246): the rest of the opening position at 30 Nov 2026. No data (decision 79): rows come from the importer through the doors. Forward migration.
--   payment_instrument.due_date   the due date of a cheque or LCN when it is not the date written on it (an LCN is drawn on one date and falls due on another). NULL = the written date.
--   opening_open_item             per-invoice open items of a client or supplier at the opening date: invoice number, date, due date, amount, balance. Insert-only, doors-only, owner / app_admin.
--                                 The party's single opening line (opening_party_balance, aging_unknown) stays the fallback when the sheet has no per-invoice detail; a party that has items has
--                                 its line created from them (aging_unknown = false) and the door refuses items whose balances add up to more than the line.
--   opening_obligation(+_instalment)  loans and leasing at the opening date with their instalment schedule (lender, reference, one row per instalment). Insert-only, doors-only, owner / app_admin.
-- Opening stock needs no new table: it is the existing 'opening' stock movement (one per component and plant, dated, signed positive).
ALTER TABLE public.payment_instrument ADD COLUMN due_date date;
--> statement-breakpoint
ALTER TABLE public.payment_instrument ADD CONSTRAINT payment_instrument_due_paper CHECK (due_date IS NULL OR (method IN ('cheque', 'lcn') AND written_date IS NOT NULL AND due_date >= written_date));
--> statement-breakpoint
-- J-1 follows the due date when there is one (CREATE OR REPLACE: same signature as 0245)
CREATE OR REPLACE FUNCTION public.outgoing_due_tomorrow(p_date date)
  RETURNS TABLE(o_id uuid, o_supplier_code text, o_supplier_name text, o_method text, o_number text, o_bank text, o_amount bigint, o_due date)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('outgoing_due_tomorrow');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_purchases']) THEN
    RAISE EXCEPTION 'outgoing_due_tomorrow: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT i.id, s.code, s.name, i.method, i.number, i.bank, i.amount_centimes, coalesce(i.due_date, i.written_date)
    FROM public.payment_instrument i JOIN public.supplier s ON s.id = i.supplier_id
   WHERE i.direction = 'out' AND coalesce(i.due_date, i.written_date) = p_date + 1
     AND NOT EXISTS (SELECT 1 FROM public.instrument_event e WHERE e.instrument_id = i.id AND e.event IN ('cleared', 'cancelled', 'bounced'))
   ORDER BY i.amount_centimes DESC;
END $$;
--> statement-breakpoint
-- the doors below read the party's opening line: the definer role needs a read policy on it (as on ledger_opening)
CREATE POLICY opening_party_balance_definer_read ON public.opening_party_balance FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE TABLE public.opening_open_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid REFERENCES public.client (id),
  supplier_id      uuid REFERENCES public.supplier (id),
  invoice_number   text NOT NULL CHECK (invoice_number = btrim(invoice_number) AND length(invoice_number) BETWEEN 1 AND 60),
  invoice_date     date NOT NULL,
  due_date         date NOT NULL,
  amount_centimes  bigint NOT NULL CHECK (amount_centimes > 0),
  balance_centimes bigint NOT NULL CHECK (balance_centimes > 0),
  source           text NOT NULL DEFAULT 'opening_30_11' CHECK (source = 'opening_30_11'),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((client_id IS NULL) <> (supplier_id IS NULL)),
  CHECK (balance_centimes <= amount_centimes),
  CHECK (due_date >= invoice_date)
);
--> statement-breakpoint
CREATE UNIQUE INDEX opening_open_item_client_idx ON public.opening_open_item (client_id, lower(invoice_number)) WHERE client_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX opening_open_item_supplier_idx ON public.opening_open_item (supplier_id, lower(invoice_number)) WHERE supplier_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE public.opening_obligation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('loan', 'leasing')),
  lender      text NOT NULL CHECK (lender = btrim(lender) AND length(lender) BETWEEN 2 AND 120),
  reference   text NOT NULL CHECK (reference = btrim(reference) AND length(reference) BETWEEN 1 AND 60),
  source      text NOT NULL DEFAULT 'opening_30_11' CHECK (source = 'opening_30_11'),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX opening_obligation_reference_idx ON public.opening_obligation (lower(reference));
--> statement-breakpoint
CREATE TABLE public.opening_obligation_instalment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id   uuid NOT NULL REFERENCES public.opening_obligation (id),
  due_date        date NOT NULL,
  amount_centimes bigint NOT NULL CHECK (amount_centimes > 0),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, due_date)
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['opening_open_item', 'opening_obligation', 'opening_obligation_instalment'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql SET search_path = '''' AS $f$ BEGIN RAISE EXCEPTION ''%s is insert-only'' USING ERRCODE = ''integrity_constraint_violation''; END $f$', t || '_sealed', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', t || '_sealed', t, t || '_sealed');
    EXECUTE format('SELECT audit.attach(%L)', 'public.' || t);
  END LOOP;
END $$;
--> statement-breakpoint
-- One invoice of a party's per-invoice opening detail. The party's opening line must exist (created with aging_unknown = false from the sheet); the balances of its items never add up to more than the line.
CREATE FUNCTION public.add_opening_open_item(p_client uuid, p_supplier uuid, p_invoice_number text, p_invoice_date date, p_due_date date, p_amount bigint, p_balance bigint) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
  v_line bigint;
  v_sum  bigint;
BEGIN
  v_role := ctx.require_admitted_actor('add_opening_open_item');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'add_opening_open_item: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_client IS NULL) = (p_supplier IS NULL) THEN
    RAISE EXCEPTION 'add_opening_open_item: a client or a supplier' USING ERRCODE = 'check_violation';
  END IF;
  SELECT b.amount_centimes INTO v_line FROM public.opening_party_balance b
   WHERE (p_client IS NOT NULL AND b.client_id = p_client) OR (p_supplier IS NOT NULL AND b.supplier_id = p_supplier);
  IF v_line IS NULL THEN
    RAISE EXCEPTION 'add_opening_open_item: the party has no opening balance line' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(o.balance_centimes), 0) INTO v_sum FROM public.opening_open_item o
   WHERE (p_client IS NOT NULL AND o.client_id = p_client) OR (p_supplier IS NOT NULL AND o.supplier_id = p_supplier);
  IF v_sum + p_balance > v_line THEN
    RAISE EXCEPTION 'add_opening_open_item: the open items add up to more than the opening balance line' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.opening_open_item (id, client_id, supplier_id, invoice_number, invoice_date, due_date, amount_centimes, balance_centimes, created_by)
  VALUES (v_id, p_client, p_supplier, btrim(p_invoice_number), p_invoice_date, p_due_date, p_amount, p_balance, ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
-- The per-invoice detail with the party's line next to it: kind 'client' or 'supplier' (NULL = both); one row per item. owner, app_admin.
CREATE FUNCTION public.opening_open_item_list(p_kind text, p_limit integer)
  RETURNS TABLE(o_kind text, o_party_id uuid, o_party_name text, o_invoice_number text, o_invoice_date date, o_due_date date, o_amount bigint, o_balance bigint, o_line bigint, o_items_total bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('opening_open_item_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'opening_open_item_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT CASE WHEN o.client_id IS NOT NULL THEN 'client' ELSE 'supplier' END, coalesce(o.client_id, o.supplier_id), coalesce(c.name, s.name),
         o.invoice_number, o.invoice_date, o.due_date, o.amount_centimes, o.balance_centimes,
         (SELECT b.amount_centimes FROM public.opening_party_balance b WHERE b.client_id = o.client_id OR b.supplier_id = o.supplier_id),
         (SELECT sum(x.balance_centimes) FROM public.opening_open_item x WHERE x.client_id = o.client_id OR x.supplier_id = o.supplier_id)::bigint
    FROM public.opening_open_item o LEFT JOIN public.client c ON c.id = o.client_id LEFT JOIN public.supplier s ON s.id = o.supplier_id
   WHERE p_kind IS NULL OR (p_kind = 'client' AND o.client_id IS NOT NULL) OR (p_kind = 'supplier' AND o.supplier_id IS NOT NULL)
   ORDER BY 3, o.due_date, o.invoice_number
   LIMIT greatest(1, least(coalesce(p_limit, 2000), 10000));
END $$;
--> statement-breakpoint
CREATE FUNCTION public.add_opening_obligation(p_kind text, p_lender text, p_reference text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('add_opening_obligation');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'add_opening_obligation: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.opening_obligation (id, kind, lender, reference, created_by) VALUES (v_id, p_kind, btrim(p_lender), btrim(p_reference), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.add_opening_instalment(p_obligation uuid, p_due date, p_amount bigint) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('add_opening_instalment');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'add_opening_instalment: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.opening_obligation_instalment (id, obligation_id, due_date, amount_centimes, created_by) VALUES (v_id, p_obligation, p_due, p_amount, ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
-- Obligations with their schedule, one row per instalment (owner, app_admin).
CREATE FUNCTION public.opening_obligation_list(p_limit integer)
  RETURNS TABLE(o_id uuid, o_kind text, o_lender text, o_reference text, o_due date, o_amount bigint, o_total bigint, o_count integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('opening_obligation_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'opening_obligation_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT o.id, o.kind, o.lender, o.reference, i.due_date, i.amount_centimes,
         (SELECT sum(x.amount_centimes) FROM public.opening_obligation_instalment x WHERE x.obligation_id = o.id)::bigint,
         (SELECT count(*) FROM public.opening_obligation_instalment x WHERE x.obligation_id = o.id)::integer
    FROM public.opening_obligation o LEFT JOIN public.opening_obligation_instalment i ON i.obligation_id = o.id
   ORDER BY o.reference, i.due_date
   LIMIT greatest(1, least(coalesce(p_limit, 5000), 20000));
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.add_opening_open_item(uuid, uuid, text, date, date, bigint, bigint)', 'public.opening_open_item_list(text, integer)',
    'public.add_opening_obligation(text, text, text)', 'public.add_opening_instalment(uuid, date, bigint)', 'public.opening_obligation_list(integer)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
