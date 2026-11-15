-- T19 item 4 (ADMIN-GAP A2, A4, A5): the client PO number, the commercial of an order, the client aliases, and two per-client flags. No data (decision 79). Forward migration.
-- DESIGN: the order doors (create_order_with_method and the owner path) are NOT rewritten. The extras live in order_extra (order_id, client_po, commercial), written by the door
-- set_order_extra in the SAME transaction as the order; a DEFERRED constraint trigger refuses, at commit, an order of a client flagged po_required that has no client_po.
-- The BL and the invoice read the PO of their order(s); nothing is copied (one source).
--   client.po_required   the client's PO number is mandatory on its orders (default false); client.price_basis 'HT' | 'TTC' = how this client's prices are agreed (default HT; shown, the ledger stays HT: partial, D-note in the report).
--   client_alias         alternate names mapped to ONE client (the importer and the search use them). Insert-only, doors-only: add_client_alias, client_alias_list.
ALTER TABLE public.client ADD COLUMN po_required boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.client ADD COLUMN price_basis text NOT NULL DEFAULT 'HT' CHECK (price_basis IN ('HT', 'TTC'));
--> statement-breakpoint
CREATE TABLE public.order_extra (
  order_id   uuid PRIMARY KEY REFERENCES public.sales_order (id),
  client_po  text CHECK (client_po = btrim(client_po) AND length(client_po) BETWEEN 1 AND 60),
  commercial text CHECK (commercial = btrim(commercial) AND length(commercial) BETWEEN 1 AND 80),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.client_alias (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES public.client (id),
  alias      text NOT NULL CHECK (alias = btrim(alias) AND length(alias) BETWEEN 2 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- an alias identifies ONE client: unique ignoring case and accents-free spacing
CREATE UNIQUE INDEX client_alias_unique ON public.client_alias (lower(alias));
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_extra', 'client_alias'] LOOP
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
CREATE FUNCTION public.set_order_extra(p_order uuid, p_client_po text, p_commercial text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('set_order_extra');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office', 'office_sales']) THEN
    RAISE EXCEPTION 'set_order_extra: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sales_order o WHERE o.id = p_order AND o.created_by = ctx.user_id()) THEN
    RAISE EXCEPTION 'set_order_extra: the order is not yours or unknown' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.order_extra (order_id, client_po, commercial, created_by)
  VALUES (p_order, nullif(btrim(coalesce(p_client_po, '')), ''), nullif(btrim(coalesce(p_commercial, '')), ''), ctx.user_id());
END $$;
--> statement-breakpoint
CREATE FUNCTION public.order_po_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.reverses_id IS NULL
     AND EXISTS (SELECT 1 FROM public.client c WHERE c.id = NEW.client_id AND c.po_required)
     AND NOT EXISTS (SELECT 1 FROM public.order_extra x WHERE x.order_id = NEW.id AND x.client_po IS NOT NULL) THEN
    RAISE EXCEPTION 'sales_order: this client requires its purchase-order number (client PO)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_po_required AFTER INSERT ON public.sales_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.order_po_check();
--> statement-breakpoint
-- the PO and the commercial of orders, for the roles that read orders' documents: the BL and the invoice show the PO. Read by id list.
CREATE FUNCTION public.order_extras(p_orders uuid[])
  RETURNS TABLE(o_order_id uuid, o_client_po text, o_commercial text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('order_extras');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office', 'office_sales', 'office_purchases', 'plant', 'plant_manager', 'accountant', 'support']) THEN
    RAISE EXCEPTION 'order_extras: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT x.order_id, x.client_po, x.commercial FROM public.order_extra x WHERE x.order_id = ANY (p_orders);
END $$;
--> statement-breakpoint
CREATE FUNCTION public.set_client_terms(p_client uuid, p_po_required boolean, p_price_basis text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('set_client_terms');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office_sales']) THEN
    RAISE EXCEPTION 'set_client_terms: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_price_basis IS NULL OR p_price_basis <> ALL (ARRAY['HT', 'TTC']) THEN
    RAISE EXCEPTION 'set_client_terms: price basis is HT or TTC' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.client SET po_required = coalesce(p_po_required, false), price_basis = p_price_basis WHERE id = p_client;
  IF NOT FOUND THEN RAISE EXCEPTION 'set_client_terms: unknown client' USING ERRCODE = 'check_violation'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.add_client_alias(p_client uuid, p_alias text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('add_client_alias');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office', 'office_sales']) THEN
    RAISE EXCEPTION 'add_client_alias: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.client c WHERE c.id = p_client) THEN
    RAISE EXCEPTION 'add_client_alias: unknown client' USING ERRCODE = 'check_violation';
  END IF;
  -- an alias may not be the exact name of ANOTHER client either
  IF EXISTS (SELECT 1 FROM public.client c WHERE lower(c.name) = lower(btrim(p_alias)) AND c.id <> p_client) THEN
    RAISE EXCEPTION 'add_client_alias: this is the name of another client' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.client_alias (id, client_id, alias, created_by) VALUES (v_id, p_client, btrim(p_alias), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.client_alias_list(p_client uuid)
  RETURNS TABLE(o_id uuid, o_client_id uuid, o_client_code text, o_alias text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('client_alias_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin', 'office', 'office_sales', 'office_purchases', 'support']) THEN
    RAISE EXCEPTION 'client_alias_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT a.id, a.client_id, c.code, a.alias FROM public.client_alias a JOIN public.client c ON c.id = a.client_id
   WHERE p_client IS NULL OR a.client_id = p_client ORDER BY lower(a.alias);
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.set_order_extra(uuid, text, text)', 'public.order_extras(uuid[])', 'public.set_client_terms(uuid, boolean, text)',
    'public.add_client_alias(uuid, text)', 'public.client_alias_list(uuid)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
