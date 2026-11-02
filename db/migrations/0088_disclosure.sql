-- §16.3 (REQUIREMENTS-V1 §11, §12, §16.3): figure disclosure. A person without money access asks to see ONE figure of ONE data item
-- (and the document it comes from); the owner or app_admin approves for that person only. The default is a single view that must be
-- taken within 15 minutes; a window of up to 60 minutes with several views is the alternative. Every view is audited, with the item.
-- The figure is computed by the database at view time; the request row holds none.
CREATE TABLE public.disclosure_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester     uuid NOT NULL,
  item_kind     text NOT NULL CHECK (item_kind IN ('order_total', 'invoice_total', 'client_balance')),
  item_ref      text NOT NULL CHECK (item_ref = btrim(item_ref) AND length(item_ref) BETWEEN 1 AND 40),
  document_kind text CHECK (document_kind IN ('order', 'invoice', 'quote', 'statement')),
  document_ref  text CHECK (document_ref IS NULL OR length(document_ref) BETWEEN 1 AND 40),
  reason        text CHECK (reason IS NULL OR length(reason) <= 300),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  mode          text CHECK (mode IN ('single_view', 'window')),
  decided_by    uuid,
  decided_at    timestamptz,
  expires_at    timestamptz,
  views_allowed integer CHECK (views_allowed IS NULL OR views_allowed > 0),
  views_used    integer NOT NULL DEFAULT 0 CHECK (views_used >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_by IS NULL)),
  CHECK (status <> 'approved' OR (mode IS NOT NULL AND expires_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE public.disclosure_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.disclosure_request FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.disclosure_request FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.disclosure_request TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY disclosure_request_read ON public.disclosure_request FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY support_read ON public.disclosure_request FOR SELECT TO belgobeton_app USING (ctx.role() = 'support');
--> statement-breakpoint
CREATE POLICY disclosure_request_definer ON public.disclosure_request FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
SELECT audit.attach('public.disclosure_request');
--> statement-breakpoint

CREATE FUNCTION public.request_disclosure(p_kind text, p_ref text, p_document_kind text, p_document_ref text, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_ref text := btrim(coalesce(p_ref, ''));
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('office', 'office_sales', 'office_purchases', 'plant', 'plant_manager') THEN
    RAISE EXCEPTION 'request_disclosure: role % may not ask for a figure', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (CASE p_kind
            WHEN 'order_total'   THEN EXISTS (SELECT 1 FROM public.sales_order WHERE code = v_ref)
            WHEN 'invoice_total' THEN EXISTS (SELECT 1 FROM public.invoice WHERE number = v_ref)
            WHEN 'client_balance' THEN EXISTS (SELECT 1 FROM public.client WHERE code = v_ref)
            ELSE false END) THEN
    RAISE EXCEPTION 'request_disclosure: unknown item' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.disclosure_request WHERE requester = ctx.user_id() AND item_kind = p_kind AND item_ref = v_ref AND status = 'pending') THEN
    RAISE EXCEPTION 'request_disclosure: already waiting' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO public.disclosure_request (requester, item_kind, item_ref, document_kind, document_ref, reason)
  VALUES (ctx.user_id(), p_kind, v_ref, p_document_kind, nullif(btrim(p_document_ref), ''), nullif(btrim(p_reason), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.decide_disclosure(p_id uuid, p_approve boolean, p_mode text, p_minutes integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.disclosure_request%ROWTYPE; v_min integer := coalesce(p_minutes, 15);
BEGIN
  IF ctx.role() IS NULL OR ctx.role() <> 'owner' THEN
    RAISE EXCEPTION 'decide_disclosure: role % may not decide', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v FROM public.disclosure_request WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v.status <> 'pending' THEN RAISE EXCEPTION 'decide_disclosure: nothing to decide' USING ERRCODE = 'check_violation'; END IF;
  IF v.requester = ctx.user_id() THEN RAISE EXCEPTION 'decide_disclosure: nobody approves their own request' USING ERRCODE = 'check_violation'; END IF;
  IF p_approve THEN
    IF coalesce(p_mode, 'single_view') NOT IN ('single_view', 'window') OR v_min NOT BETWEEN 1 AND 60 THEN
      RAISE EXCEPTION 'decide_disclosure: invalid scope' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.disclosure_request SET status = 'approved', mode = coalesce(p_mode, 'single_view'), decided_by = ctx.user_id(), decided_at = now(),
           expires_at = now() + make_interval(mins => v_min), views_allowed = CASE WHEN coalesce(p_mode, 'single_view') = 'single_view' THEN 1 END
     WHERE id = p_id;
  ELSE
    UPDATE public.disclosure_request SET status = 'denied', decided_by = ctx.user_id(), decided_at = now() WHERE id = p_id;
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint
-- The figure, once per allowed view, to the requester only. Out of scope (not approved, expired, views used up, someone else's): refused.
CREATE FUNCTION public.view_disclosure(p_id uuid) RETURNS TABLE(item_kind text, item_ref text, centimes bigint, views_left integer, expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.disclosure_request%ROWTYPE; v_c bigint;
BEGIN
  SELECT * INTO v FROM public.disclosure_request d WHERE d.id = p_id FOR UPDATE;
  IF NOT FOUND OR v.requester <> ctx.user_id() OR v.status <> 'approved' OR now() >= v.expires_at
     OR (v.views_allowed IS NOT NULL AND v.views_used >= v.views_allowed) THEN
    RAISE EXCEPTION 'view_disclosure: not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_c := CASE v.item_kind
    WHEN 'order_total'    THEN (SELECT o.total_ttc_centimes FROM public.sales_order o WHERE o.code = v.item_ref AND o.reverses_id IS NULL)
    WHEN 'invoice_total'  THEN (SELECT i.total_ttc_centimes FROM public.invoice i WHERE i.number = v.item_ref)
    WHEN 'client_balance' THEN (SELECT public.client_open_centimes(c.id) FROM public.client c WHERE c.code = v.item_ref) END;
  UPDATE public.disclosure_request d SET views_used = d.views_used + 1 WHERE d.id = p_id;
  PERFORM audit.record('view', 'disclosure:' || v.item_kind || ':' || v.item_ref, p_id::text, NULL,
                       jsonb_build_object('viewer', ctx.user_id(), 'document', v.document_kind, 'view', v.views_used + 1), NULL);
  RETURN QUERY SELECT v.item_kind, v.item_ref, v_c,
                      CASE WHEN v.views_allowed IS NULL THEN NULL ELSE v.views_allowed - v.views_used - 1 END, v.expires_at;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.my_disclosures() RETURNS TABLE(id uuid, item_kind text, item_ref text, status text, mode text, expires_at timestamptz, views_left integer, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.item_kind, d.item_ref, d.status, d.mode, d.expires_at,
         CASE WHEN d.views_allowed IS NULL THEN NULL ELSE d.views_allowed - d.views_used END, d.created_at
    FROM public.disclosure_request d WHERE d.requester = ctx.user_id() ORDER BY d.created_at DESC LIMIT 50
$$;
--> statement-breakpoint
CREATE FUNCTION public.disclosures_pending() RETURNS TABLE(id uuid, requester_name text, item_kind text, item_ref text, document_kind text, reason text, created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'support') THEN
    RAISE EXCEPTION 'disclosures_pending: role % may not read them', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT d.id, u.name, d.item_kind, d.item_ref, d.document_kind, d.reason, d.created_at
                 FROM public.disclosure_request d JOIN public."user" u ON u.id = d.requester::text
                WHERE d.status = 'pending' ORDER BY d.created_at;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['request_disclosure(text, text, text, text, text)', 'decide_disclosure(uuid, boolean, text, integer)',
                           'view_disclosure(uuid)', 'my_disclosures()', 'disclosures_pending()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
END $$;
