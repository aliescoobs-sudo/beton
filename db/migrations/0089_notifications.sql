-- R5 (CP-PROD-PLAN, REQUIREMENTS-V1 §13): the in-app notification centre and web push to the installed PWA.
-- A notification is one row per recipient: a kind from the catalogue, small parameters (codes, never an amount), a link and a
-- severity. The app is the channel; the push carries no content at all (a bare wake-up), so the phone shows a generic line and
-- the person opens the app to read. Money never enters a notification: a check forbids the money keys.
CREATE TABLE public.notification (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN (
               'emergency', 'driver_instruction', 'approval_pending', 'stock_low', 'stock_shortage', 'cheque_bounced',
               'receivable_due', 'receivable_overdue', 'payable_due', 'cash_deficit', 'invoice_month_end', 'law6921',
               'day_conflict', 'shipment_delay', 'receipt_late', 'order_cancelled', 'cancel_do_not_load', 'redirect_proposal',
               'loss_recorded', 'transfer', 'day_close_blocking', 'document_request', 'test')),
  severity   text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'important', 'urgent')),
  params     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object' AND length(params::text) <= 1000
               AND NOT (params ?| ARRAY['amount', 'amount_centimes', 'total', 'price', 'centimes', 'balance', 'figure'])),
  link       text CHECK (link IS NULL OR link ~ '^/[a-z0-9/_-]*$'),
  plant_id   uuid REFERENCES public.plant(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  pushed_at  timestamptz
);
--> statement-breakpoint
CREATE INDEX notification_recipient_idx ON public.notification (recipient, created_at DESC);
--> statement-breakpoint
CREATE INDEX notification_unpushed_idx ON public.notification (recipient) WHERE pushed_at IS NULL;
--> statement-breakpoint
-- One browser or installed PWA of one person. The endpoint is a bearer capability: nobody reads this table, only the doors do.
CREATE TABLE public.push_subscription (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  -- Only the push services of the browsers: a person cannot make the server call another address (SSRF).
  endpoint   text NOT NULL UNIQUE CHECK (endpoint ~ '^https://([a-z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)/' AND length(endpoint) <= 1000),
  p256dh     text NOT NULL CHECK (length(p256dh) <= 200),
  auth       text NOT NULL CHECK (length(auth) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  failures   integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
ALTER TABLE public.notification ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.notification FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.notification FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.notification TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY notification_own ON public.notification FOR SELECT TO belgobeton_app USING (recipient = ctx.user_id());
--> statement-breakpoint
CREATE POLICY notification_definer ON public.notification FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.push_subscription ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.push_subscription FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.push_subscription FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.push_subscription TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY push_subscription_definer ON public.push_subscription FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
SELECT audit.attach('public.notification');
--> statement-breakpoint
SELECT audit.attach('public.push_subscription');
--> statement-breakpoint

-- The one writer of notifications (never granted to a request role). Recipients: active users of the roles, a plant manager only
-- for the plant named, plus named users. The legacy `office` role goes wherever an office role does.
CREATE FUNCTION public.notify(p_kind text, p_severity text, p_params jsonb, p_link text, p_plant uuid, p_roles text[], p_users uuid[])
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT u.id::uuid AS id FROM public."user" u
     WHERE u.status = 'active'
       AND (u.role = ANY (p_roles) OR (u.role = 'office' AND p_roles && ARRAY['office_sales', 'office_purchases'])
            OR (u.role = 'plant' AND p_roles && ARRAY['plant_manager']))
       AND (p_plant IS NULL OR u.role NOT IN ('plant_manager') OR u."plantId" = p_plant)
    UNION
    SELECT x FROM unnest(coalesce(p_users, '{}'::uuid[])) x
  )
  INSERT INTO public.notification (recipient, kind, severity, params, link, plant_id)
  SELECT r.id, p_kind, p_severity, coalesce(p_params, '{}'), p_link, p_plant FROM r;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.notify(text, text, jsonb, text, uuid, text[], uuid[]) FROM PUBLIC;
--> statement-breakpoint

-- Events of the catalogue that already exist as rows: the alerts of the rules engine.
CREATE FUNCTION public.notify_from_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text; v_roles text[]; v_sev text := 'important'; v_link text := '/alerts';
BEGIN
  SELECT m.kind, m.roles INTO v_kind, v_roles FROM (VALUES
    ('CASH-DEFICIT', 'cash_deficit', ARRAY['owner', 'app_admin']),
    ('CASH-DEFICIT-WORST', 'cash_deficit', ARRAY['owner', 'app_admin']),
    ('PAY-DUE', 'payable_due', ARRAY['owner', 'app_admin', 'office_purchases']),
    ('RCV-DUE', 'receivable_due', ARRAY['owner', 'app_admin', 'office_sales']),
    ('RCV-OVERDUE', 'receivable_overdue', ARRAY['owner', 'app_admin', 'office_sales']),
    ('CHQ-BOUNCED', 'cheque_bounced', ARRAY['owner', 'app_admin', 'office_sales', 'office_purchases']),
    ('STOCK-SHORTAGE', 'stock_shortage', ARRAY['owner', 'app_admin', 'office_purchases', 'plant_manager']),
    ('STOCK-LOW', 'stock_low', ARRAY['owner', 'app_admin', 'office_purchases', 'plant_manager']),
    ('LAW6921-RECEIVABLE', 'law6921', ARRAY['owner', 'app_admin']),
    ('LAW6921-PAYABLE', 'law6921', ARRAY['owner', 'app_admin']),
    ('INVOICE-MONTH-END', 'invoice_month_end', ARRAY['owner', 'app_admin', 'office_sales']),
    ('DAY-CONFLICT', 'day_conflict', ARRAY['owner', 'app_admin', 'office_sales', 'plant_manager'])
  ) AS m(rule, kind, roles) WHERE m.rule = NEW.rule_id;
  IF v_kind IS NULL THEN RETURN NEW; END IF;
  IF v_kind IN ('cash_deficit', 'cheque_bounced', 'stock_shortage') THEN v_sev := 'urgent'; END IF;
  PERFORM public.notify(v_kind, v_sev, jsonb_build_object('rule', NEW.rule_id), v_link, NULL, v_roles, NULL);
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.notify_from_alert() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER notify_from_alert AFTER INSERT ON public.alert FOR EACH ROW EXECUTE FUNCTION public.notify_from_alert();
--> statement-breakpoint

-- Approvals waiting: owner and app_admin, one notification per card, with no figure.
CREATE FUNCTION public.notify_approval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.notify('approval_pending', 'important', jsonb_build_object('card', TG_ARGV[0]), '/approvals', NULL,
                        ARRAY['owner', 'app_admin'], NULL);
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.notify_approval() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER notify_approval AFTER INSERT ON public.order_price_status FOR EACH ROW EXECUTE FUNCTION public.notify_approval('price');
--> statement-breakpoint
CREATE TRIGGER notify_approval AFTER INSERT ON public.order_hold FOR EACH ROW EXECUTE FUNCTION public.notify_approval('credit');
--> statement-breakpoint
CREATE TRIGGER notify_approval AFTER INSERT ON public.disclosure_request FOR EACH ROW EXECUTE FUNCTION public.notify_approval('disclosure');
--> statement-breakpoint

-- A driver's emergency: urgent, to office, owner, app_admin and the plant manager of the trip's plant.
CREATE FUNCTION public.notify_emergency() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_plant uuid;
BEGIN
  SELECT t.plant_id INTO v_plant FROM public.trip_plan t WHERE t.id = NEW.trip_id;
  PERFORM public.notify('emergency', 'urgent', jsonb_build_object('option', NEW.option, 'step', NEW.step), '/emergencies', v_plant,
                        ARRAY['owner', 'app_admin', 'office_sales', 'plant_manager'], NULL);
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.notify_emergency() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER notify_emergency AFTER INSERT ON public.trip_emergency FOR EACH ROW EXECUTE FUNCTION public.notify_emergency();
--> statement-breakpoint
-- The office's instruction reaches the driver it is for.
CREATE FUNCTION public.notify_instruction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user text;
BEGIN
  SELECT d.user_id INTO v_user FROM public.trip_emergency e JOIN public.driver d ON d.id = e.driver_id WHERE e.id = NEW.emergency_id;
  IF v_user IS NOT NULL THEN
    PERFORM public.notify('driver_instruction', 'urgent', jsonb_build_object('instruction', NEW.kind), '/driver', NULL, ARRAY[]::text[], ARRAY[v_user::uuid]);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.notify_instruction() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER notify_instruction AFTER INSERT ON public.trip_instruction FOR EACH ROW EXECUTE FUNCTION public.notify_instruction();
--> statement-breakpoint

-- The person's own side.
CREATE FUNCTION public.my_notifications(p_limit integer) RETURNS TABLE(id uuid, kind text, severity text, params jsonb, link text, created_at timestamptz, read_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT n.id, n.kind, n.severity, n.params, n.link, n.created_at, n.read_at FROM public.notification n
   WHERE n.recipient = ctx.user_id() ORDER BY n.created_at DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
--> statement-breakpoint
CREATE FUNCTION public.unread_notification_count() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::int FROM public.notification n WHERE n.recipient = ctx.user_id() AND n.read_at IS NULL
$$;
--> statement-breakpoint
CREATE FUNCTION public.mark_notifications_read(p_ids uuid[]) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.notification n SET read_at = now()
   WHERE n.recipient = ctx.user_id() AND n.read_at IS NULL AND (p_ids IS NULL OR n.id = ANY (p_ids));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
--> statement-breakpoint
-- "Send me a test": the way to check that the phone is set up. A real notification for the caller, kind test.
CREATE FUNCTION public.send_test_notification() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.user_id() IS NULL THEN RAISE EXCEPTION 'send_test_notification: no user' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN public.notify('test', 'info', '{}', '/notifications', NULL, ARRAY[]::text[], ARRAY[ctx.user_id()]);
END $$;
--> statement-breakpoint
CREATE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF ctx.user_id() IS NULL THEN RAISE EXCEPTION 'save_push_subscription: no user' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.push_subscription (user_id, endpoint, p256dh, auth) VALUES (ctx.user_id(), p_endpoint, p_p256dh, p_auth)
  ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failures = 0
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.drop_push_subscription(p_endpoint text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.push_subscription WHERE endpoint = p_endpoint AND user_id = ctx.user_id();
  RETURN FOUND;
END $$;
--> statement-breakpoint
-- The sender (system role only): one bare wake-up per subscription whose person has something not yet pushed.
CREATE FUNCTION public.push_outbox(p_limit integer) RETURNS TABLE(subscription_id uuid, endpoint text, p256dh text, auth text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'push_outbox: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT s.id, s.endpoint, s.p256dh, s.auth FROM public.push_subscription s
                WHERE s.failures < 5 AND EXISTS (SELECT 1 FROM public.notification n WHERE n.recipient = s.user_id AND n.pushed_at IS NULL
                                                  AND n.created_at > now() - interval '2 days')
                LIMIT least(coalesce(p_limit, 100), 500);
END $$;
--> statement-breakpoint
CREATE FUNCTION public.push_result(p_subscription uuid, p_ok boolean, p_gone boolean) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid;
BEGIN
  IF ctx.role() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'push_result: system only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_gone THEN DELETE FROM public.push_subscription WHERE id = p_subscription; RETURN; END IF;
  IF p_ok THEN
    UPDATE public.push_subscription SET last_ok_at = now(), failures = 0 WHERE id = p_subscription RETURNING user_id INTO v_user;
    UPDATE public.notification SET pushed_at = now() WHERE recipient = v_user AND pushed_at IS NULL;
  ELSE
    UPDATE public.push_subscription SET failures = failures + 1 WHERE id = p_subscription;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['my_notifications(integer)', 'unread_notification_count()', 'mark_notifications_read(uuid[])',
                           'send_test_notification()', 'save_push_subscription(text, text, text)', 'drop_push_subscription(text)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['push_outbox(integer)', 'push_result(uuid, boolean, boolean)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_system', f);
  END LOOP;
END $$;
