-- DECISIONS 81 (provisional): money visibility. New role `support` (read-only everywhere); partner and office lose every
-- money read; only the owner writes prices. Enforced here, in the database, not only in the UI.

-- 1. The `support` role. It has no write policy anywhere (every INSERT/UPDATE policy names its roles explicitly).
ALTER TABLE public."user" DROP CONSTRAINT user_role_check;
--> statement-breakpoint
ALTER TABLE public."user" ADD CONSTRAINT user_role_check CHECK ("role" IN ('owner', 'partner', 'office', 'plant', 'support'));
--> statement-breakpoint

-- 2. Every view of a money screen by support is audited (a database cannot log plain reads, so the app records it).
ALTER TABLE public.audit_event DROP CONSTRAINT audit_event_action_check;
--> statement-breakpoint
ALTER TABLE public.audit_event ADD CONSTRAINT audit_event_action_check CHECK (action IN (
  'insert', 'update', 'reverse', 'archive',
  'login', 'login_failed', 'logout', 'account_locked', 'permission_denied', 'export',
  'user_created', 'user_creation_failed', 'user_disabled', 'user_enabled', 'two_factor_reset',
  'two_factor_enrolled', 'recovery_codes_generated', 'recovery_code_used',
  'step_up', 'session_revoked', 'ai_proposal', 'ai_confirmation', 'telegram_link', 'clock_advance', 'view'));
--> statement-breakpoint

-- 3. Read-only everywhere: one SELECT policy per table for support. Later migrations call this for each new table.
CREATE FUNCTION public.grant_support_read(p_table regclass) RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS support_read ON %s', p_table);
  EXECUTE format('CREATE POLICY support_read ON %s FOR SELECT TO belgobeton_app USING (ctx.role() = ''support'')', p_table);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.grant_support_read(regclass) FROM PUBLIC;
--> statement-breakpoint
SELECT public.grant_support_read(c.oid::regclass)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
   AND has_table_privilege('belgobeton_app', c.oid, 'SELECT')
   AND c.relname <> 'security_alert_ack';
--> statement-breakpoint

-- 4. Money tables: the audit log keeps the amounts (before/after), so it is money data too. Registry of the tables
--    whose audit rows only owner and support may read; every ledger migration extends it (checked against TABLE_ACCESS).
CREATE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price')
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.is_money_table(text) TO belgobeton_app;
--> statement-breakpoint
DROP POLICY audit_event_read_all ON public.audit_event;
--> statement-breakpoint
DROP POLICY audit_event_read_own ON public.audit_event;
--> statement-breakpoint
CREATE POLICY audit_event_read_all ON public.audit_event FOR SELECT TO belgobeton_app
  USING (ctx.role() = 'owner' OR (ctx.role() = 'partner' AND NOT audit.is_money_table(table_name)));
--> statement-breakpoint
CREATE POLICY audit_event_read_own ON public.audit_event FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('office', 'plant') AND actor_user_id = ctx.user_id() AND NOT audit.is_money_table(table_name));
--> statement-breakpoint

-- 5. Prices: owner writes; owner and support read; partner, office, plant: nothing.
DROP POLICY purchase_price_read ON public.purchase_price;
--> statement-breakpoint
CREATE POLICY purchase_price_read ON public.purchase_price FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
DROP POLICY purchase_price_insert ON public.purchase_price;
--> statement-breakpoint
CREATE POLICY purchase_price_insert ON public.purchase_price FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
DROP POLICY selling_price_read ON public.selling_price;
--> statement-breakpoint
CREATE POLICY selling_price_read ON public.selling_price FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
DROP POLICY selling_price_list_insert ON public.selling_price;
--> statement-breakpoint
CREATE POLICY selling_price_list_insert ON public.selling_price FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND client_id IS NULL AND created_by = ctx.user_id());
--> statement-breakpoint
DROP POLICY selling_price_override_insert ON public.selling_price;
--> statement-breakpoint
CREATE POLICY selling_price_override_insert ON public.selling_price FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND client_id IS NOT NULL AND reason IS NOT NULL AND created_by = ctx.user_id());
