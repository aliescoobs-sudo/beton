-- R19-01: requester-only (self-service) definers answered on the strength of `requester = ctx.user_id()` alone. A request with a user id and NO role
-- (app.role unset or empty), or with the id of a user whose role is no longer one that may ask, or a reserved account, reached the lookup and, for
-- view_disclosure, returned a figure and consumed a view. The class is closed in three ways:
--   1. ONE shared helper, ctx.require_admitted_actor(door), validates an existing, active, admitted actor BEFORE any lookup: ctx.actor_role() (which raises for
--      an unknown role, a role that is not the account's, an inactive account and a reserved account while the boundary is on), then a positive test
--      (`IS NOT TRUE`, never a NULL that reads as "allowed") that the role is present, not empty, not anonymous/system, with a named user, and not reserved.
--   2. The self-service doors call it FIRST: view_disclosure, my_disclosures (0088), consume_document_copy, use_document_request, my_document_requests (0112),
--      the notification doors (0089), set_my_locale (0092), the push-subscription doors, the survey doors, and the lookup-first doors transfer_pickup,
--      transfer_receive and decide_cancellation (a missing row answered before the actor was known). The two figure/document doors also check the AUDIENCE
--      that may ask (the same list as the request door), so an account whose role changed since the approval no longer redeems it.
--   3. tests/definer-catalogue.int.test.ts classifies EVERY definer the app or auth login can execute: helper-first, or on a reviewed list with a reason.
-- Forward migration.
CREATE FUNCTION ctx.require_admitted_actor(p_door text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  -- ctx.actor_role() raises for an unknown role, a role other than the account's, an inactive account and (boundary on) a reserved account
  v_role := ctx.actor_role();
  IF (v_role IS NOT NULL AND v_role <> '' AND ctx.user_id() IS NOT NULL AND v_role <> ALL (ARRAY['anonymous', 'system'])
      AND NOT (v_role IN ('partner', 'support') AND ctx.reserved_boundary_on())) IS NOT TRUE THEN
    RAISE EXCEPTION '%: not an admitted actor', p_door USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.require_admitted_actor(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.require_admitted_actor(text) TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint

-- 0088: the figure. The audience is the one that may ask (request_disclosure); the requester must still be one of them.
CREATE OR REPLACE FUNCTION public.view_disclosure(p_id uuid)
 RETURNS TABLE(item_kind text, item_ref text, centimes bigint, views_left integer, expires_at timestamp with time zone)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.disclosure_request%ROWTYPE; v_c bigint; v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('view_disclosure');
  SELECT * INTO v FROM public.disclosure_request d WHERE d.id = p_id FOR UPDATE;
  IF NOT FOUND OR v.requester <> ctx.user_id() OR v_role <> ALL (ARRAY['office', 'office_sales', 'office_purchases', 'plant', 'plant_manager'])
     OR v.status <> 'approved' OR now() >= v.expires_at
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
CREATE OR REPLACE FUNCTION public.my_disclosures()
 RETURNS TABLE(id uuid, item_kind text, item_ref text, status text, mode text, expires_at timestamp with time zone, views_left integer, created_at timestamp with time zone)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('my_disclosures');
  RETURN QUERY
  SELECT d.id, d.item_kind, d.item_ref, d.status, d.mode, d.expires_at,
         CASE WHEN d.views_allowed IS NULL THEN NULL ELSE d.views_allowed - d.views_used END, d.created_at
    FROM public.disclosure_request d WHERE d.requester = ctx.user_id() ORDER BY d.created_at DESC LIMIT 50;
END $$;
--> statement-breakpoint

-- 0112: the document copy gate.
CREATE OR REPLACE FUNCTION public.consume_document_copy(p_id uuid, p_kind text, p_doc_ref text)
 RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v public.document_request%ROWTYPE;
  v_belongs boolean;
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('consume_document_copy');
  SELECT * INTO v FROM public.document_request d WHERE d.id = p_id FOR UPDATE;
  IF NOT FOUND OR v.requester <> ctx.user_id() OR v_role <> ALL (ARRAY['office', 'office_sales', 'office_purchases', 'accountant'])
     OR v.status <> 'approved'
     OR v.kind IS DISTINCT FROM p_kind OR v.doc_ref IS DISTINCT FROM p_doc_ref OR v.party_kind <> 'client'
     OR v.decided_at IS NULL OR v.decided_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'consume_document_copy: not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_belongs := CASE p_kind
    WHEN 'invoice_copy' THEN EXISTS (SELECT 1 FROM public.invoice i JOIN public.client c ON c.id = i.client_id WHERE i.number = p_doc_ref AND c.code = v.party_code)
    WHEN 'avoir_copy'   THEN EXISTS (SELECT 1 FROM public.avoir a JOIN public.client c ON c.id = a.client_id WHERE a.number = p_doc_ref AND c.code = v.party_code)
    WHEN 'quote_copy'   THEN EXISTS (SELECT 1 FROM public.quote q JOIN public.client c ON c.id = q.client_id WHERE q.code = p_doc_ref AND c.code = v.party_code)
    WHEN 'bl_copy'      THEN EXISTS (SELECT 1 FROM public.delivery d JOIN public.sales_order o ON o.id = d.order_id JOIN public.client c ON c.id = o.client_id WHERE d.bl_no = p_doc_ref AND c.code = v.party_code)
    ELSE false END;
  IF NOT v_belongs THEN
    RAISE EXCEPTION 'consume_document_copy: the document is not the requested client''s' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.document_request d SET status = 'used', used_at = now() WHERE d.id = p_id;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.use_document_request(p_id uuid)
 RETURNS TABLE(kind text, party_kind text, party_code text, doc_ref text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.document_request%ROWTYPE; v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('use_document_request');
  SELECT * INTO v FROM public.document_request d WHERE d.id = p_id FOR UPDATE;
  IF NOT FOUND OR v.requester <> ctx.user_id() OR v_role <> ALL (ARRAY['office', 'office_sales', 'office_purchases', 'accountant'])
     OR v.status <> 'approved' OR v.decided_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'use_document_request: not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v.kind NOT IN ('releve', 'supplier_statement') THEN
    RAISE EXCEPTION 'use_document_request: a document copy is released by its download' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.document_request d SET status = 'used', used_at = now() WHERE d.id = p_id;
  RETURN QUERY SELECT v.kind, v.party_kind, v.party_code, v.doc_ref;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.my_document_requests()
 RETURNS TABLE(id uuid, kind text, party_kind text, party_code text, doc_ref text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('my_document_requests');
  RETURN QUERY
  SELECT d.id, d.kind, d.party_kind, d.party_code, d.doc_ref,
         CASE WHEN d.status = 'approved' AND d.decided_at < now() - interval '24 hours' THEN 'expired' ELSE d.status END, d.created_at
    FROM public.document_request d WHERE d.requester = ctx.user_id() ORDER BY d.created_at DESC LIMIT 50;
END $$;
--> statement-breakpoint

-- 0089: notifications.
CREATE OR REPLACE FUNCTION public.my_notifications(p_limit integer)
 RETURNS TABLE(id uuid, kind text, severity text, params jsonb, link text, created_at timestamp with time zone, read_at timestamp with time zone)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('my_notifications');
  RETURN QUERY
  SELECT n.id, n.kind, n.severity, n.params, n.link, n.created_at, n.read_at FROM public.notification n
   WHERE n.recipient = ctx.user_id() ORDER BY n.created_at DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[]) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  PERFORM ctx.require_admitted_actor('mark_notifications_read');
  UPDATE public.notification n SET read_at = now()
   WHERE n.recipient = ctx.user_id() AND n.read_at IS NULL AND (p_ids IS NULL OR n.id = ANY (p_ids));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.unread_notification_count() RETURNS integer
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('unread_notification_count');
  RETURN (SELECT count(*)::int FROM public.notification n WHERE n.recipient = ctx.user_id() AND n.read_at IS NULL);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.send_test_notification() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('send_test_notification');
  RETURN public.notify('test', 'info', '{}', '/notifications', NULL, ARRAY[]::text[], ARRAY[ctx.user_id()]);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM ctx.require_admitted_actor('save_push_subscription');
  INSERT INTO public.push_subscription (user_id, endpoint, p256dh, auth) VALUES (ctx.user_id(), p_endpoint, p_p256dh, p_auth)
  ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failures = 0
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.drop_push_subscription(p_endpoint text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('drop_push_subscription');
  DELETE FROM public.push_subscription WHERE endpoint = p_endpoint AND user_id = ctx.user_id();
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- 0092: the language.
CREATE OR REPLACE FUNCTION public.set_my_locale(p_locale text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('set_my_locale');
  IF p_locale IS NULL OR p_locale NOT IN ('fr', 'ar', 'ary') THEN
    RAISE EXCEPTION 'set_my_locale: unknown language' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public."user" SET locale = p_locale WHERE id = ctx.user_id()::text;
END $$;
--> statement-breakpoint

-- Surveys (the audience is the actor's own role).
CREATE OR REPLACE FUNCTION public.my_surveys() RETURNS TABLE(id uuid, title text, questions jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM ctx.require_admitted_actor('my_surveys');
  RETURN QUERY
  SELECT s.id, s.title, s.questions FROM public.survey s
   WHERE s.status = 'open' AND s.audience_role = ctx.actor_role()
     AND NOT EXISTS (SELECT 1 FROM public.survey_response r WHERE r.survey_id = s.id AND r.respondent = ctx.user_id())
   ORDER BY s.created_at;
END $$;
--> statement-breakpoint

-- Doors that looked a row up (and answered "no such row") before the actor was known: the helper goes first. The rest of each body is unchanged.
DO $$
DECLARE
  def text; fixed text; f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['answer_survey(uuid, jsonb)', 'transfer_pickup(uuid, text)', 'transfer_receive(uuid, bigint, date, text)'] LOOP
    def := pg_catalog.pg_get_functiondef(('public.' || f)::regprocedure);
    fixed := regexp_replace(def, E'(\nBEGIN\n)', E'\\1  PERFORM ctx.require_admitted_actor(''' || split_part(f, '(', 1) || E''');\n');
    IF fixed = def OR fixed NOT LIKE '%ctx.require_admitted_actor%' THEN
      RAISE EXCEPTION '0224: % was not rewritten', f;
    END IF;
    EXECUTE fixed;
  END LOOP;
  -- decide_cancellation: the step-up check is not an actor check; the helper goes before it.
  FOR def IN SELECT pg_catalog.pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'decide_cancellation' LOOP
    fixed := regexp_replace(def, E'(\nBEGIN\n)', E'\\1  PERFORM ctx.require_admitted_actor(''decide_cancellation'');\n');
    IF fixed = def THEN RAISE EXCEPTION '0224: decide_cancellation was not rewritten'; END IF;
    EXECUTE fixed;
  END LOOP;
END $$;
--> statement-breakpoint

-- Found by the catalogue sweep once it called the doors with real arguments: the receipt wrappers refused only office_sales, so a request with no role went on to
-- the inner function, which looked the purchase's plant confirmation up and answered "the plant has not confirmed" (an existence oracle) before the core door
-- refused the missing role. The actor is read first.
CREATE OR REPLACE FUNCTION public.record_receipt(p_purchase uuid, p_date date) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- the system role (the seed, the jobs) records receipts too, so the admitted-actor helper (which refuses it) is not used: the actor is read FIRST and a missing one refused
  IF coalesce(ctx.actor_role(), '') IN ('', 'anonymous') THEN
    RAISE EXCEPTION 'record_receipt: not an admitted actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ctx.actor_role() = 'office_sales' THEN
    RAISE EXCEPTION '%: role % may not use this door', 'record_receipt', ctx.actor_role() USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.record_receipt__inner(p_purchase, p_date);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.record_receipt_lines(p_purchase uuid, p_date date, p_lines jsonb, p_confirm_excess boolean) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- the system role (the seed, the jobs) records receipts too, so the admitted-actor helper (which refuses it) is not used: the actor is read FIRST and a missing one refused
  IF coalesce(ctx.actor_role(), '') IN ('', 'anonymous') THEN
    RAISE EXCEPTION 'record_receipt_lines: not an admitted actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ctx.actor_role() = 'office_sales' THEN
    RAISE EXCEPTION '%: role % may not use this door', 'record_receipt_lines', ctx.actor_role() USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.record_receipt_lines__inner(p_purchase, p_date, p_lines, p_confirm_excess);
END $$;
