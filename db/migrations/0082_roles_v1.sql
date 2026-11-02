-- R2 (CP-PROD-PLAN, REQUIREMENTS-V1 §3, DECISIONS 126 to 128): the V1 roles.
-- Design (DECISIONS 139): every policy of the pilot is keyed on the five "policy roles" (owner, partner, office, plant,
-- support). A V1 account keeps its own role in "user".role (the ACTOR role, ctx.actor_role()) and is MAPPED to a policy
-- role by ctx.role(): app_admin -> owner, office_sales and office_purchases -> office, plant_manager -> plant. The roles
-- with no mapping (driver, pump_operator, accountant, client_portal, supplier_portal) match no policy: default deny, then
-- explicit read policies below (accountant) or, later, definer functions (driver, R4). Where two roles of one policy role
-- must differ (sales vs purchases) the definer functions check ctx.actor_role().

ALTER TABLE public."user" DROP CONSTRAINT user_role_check;
--> statement-breakpoint
ALTER TABLE public."user" ADD CONSTRAINT user_role_check CHECK (role IN (
  'owner', 'partner', 'office', 'plant', 'support',
  'app_admin', 'office_sales', 'office_purchases', 'plant_manager', 'driver', 'pump_operator', 'accountant',
  'client_portal', 'supplier_portal'));
--> statement-breakpoint
-- A plant manager works in one plant (set by the owner or app_admin); nobody else has one.
ALTER TABLE public."user" ADD COLUMN "plantId" uuid REFERENCES public.plant(id);
--> statement-breakpoint
-- (A manager is created disabled and gets its plant before it is activated: the plant is required once active.)
ALTER TABLE public."user" ADD CONSTRAINT user_plant_scope CHECK (
  (role <> 'plant_manager' AND "plantId" IS NULL) OR (role = 'plant_manager' AND (status <> 'active' OR "plantId" IS NOT NULL)));
--> statement-breakpoint
GRANT REFERENCES ON public.plant TO belgobeton_auth;
--> statement-breakpoint

-- The validated actor role (what the account really is). The old body of ctx.role().
CREATE FUNCTION ctx.actor_role() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := nullif(current_setting('app.role', true), '');
  v_user uuid := ctx.user_id();
  v_ok   boolean := false;
BEGIN
  IF v_role IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_role = 'system' THEN
    v_ok := v_user IN ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002');
  ELSIF v_role = 'anonymous' THEN
    v_ok := v_user = '00000000-0000-7000-8000-000000000000';
  ELSIF v_user IS NOT NULL THEN
    SELECT true INTO v_ok FROM public."user" u
     WHERE u.id = v_user::text AND u.role = v_role AND u.status = 'active';
  END IF;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'ctx: request role % does not match the stored role of user %', v_role, v_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.actor_role() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.actor_role() TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint
-- The policy role: what every RLS policy reads.
CREATE OR REPLACE FUNCTION ctx.role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE r
           WHEN 'app_admin' THEN 'owner'
           WHEN 'office_sales' THEN 'office'
           WHEN 'office_purchases' THEN 'office'
           WHEN 'plant_manager' THEN 'plant'
           ELSE r END
    FROM (SELECT ctx.actor_role() AS r) a
$$;
--> statement-breakpoint

-- The plant a plant manager is bound to; null for everybody else. Its rows only, enforced below.
CREATE FUNCTION ctx.plant_scope() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN ctx.actor_role() = 'plant_manager'
              THEN (SELECT u."plantId" FROM public."user" u WHERE u.id = ctx.user_id()::text) END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.plant_scope() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.plant_scope() TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint
-- A scoped manager cannot choose another plant: the scope wins over the request's plant.
CREATE OR REPLACE FUNCTION ctx.plant_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT coalesce(ctx.plant_scope(), nullif(current_setting('app.plant_id', true), '')::uuid) $$;
--> statement-breakpoint

-- Plant scope: RESTRICTIVE policies are ANDed with the permissive ones of the pilot. A row with no plant (pump trucks,
-- hired trucks, data from before plants) stays visible; a plant manager never reads or writes another plant's row.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_order', 'delivery', 'trip_plan', 'stock_movement', 'stock_threshold', 'purchase',
                           'purchase_receipt', 'receipt_plant_confirmation', 'fuel_fill', 'fuel_purchase', 'truck'] LOOP
    EXECUTE format(
      'CREATE POLICY plant_scope ON public.%I AS RESTRICTIVE FOR ALL TO belgobeton_app
         USING (ctx.plant_scope() IS NULL OR plant_id IS NULL OR plant_id = ctx.plant_scope())
         WITH CHECK (ctx.plant_scope() IS NULL OR plant_id IS NULL OR plant_id = ctx.plant_scope())', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE VIEW public.sales_order_ops WITH (security_barrier = true) AS
 SELECT o.id, o.code, o.concrete_type_id, o.volume_l, o.delivery_date, o.zone_id, o.site_id, c.code AS client_code,
    s.label AS site_label, o.reverses_id,
    (EXISTS ( SELECT 1 FROM public.sales_order r WHERE (r.reverses_id = o.id))) AS is_reversed,
    o.plant_id
   FROM ((public.sales_order o
     JOIN public.client c ON ((c.id = o.client_id)))
     LEFT JOIN public.client_site s ON ((s.id = o.site_id)))
  WHERE ctx.role() = ANY (ARRAY['owner'::text, 'support'::text, 'partner'::text, 'plant'::text])
    AND (ctx.plant_scope() IS NULL OR o.plant_id IS NULL OR o.plant_id = ctx.plant_scope());
--> statement-breakpoint
CREATE OR REPLACE VIEW public.purchase_line_ops WITH (security_barrier = true) AS
 SELECT p.id AS purchase_id, p.code, s.code AS supplier_code, p.order_date, l.id AS line_id, l.seq, c.id AS component_id,
    c.name_fr, c.name_ar, u.label AS unit_label, u.factor_to_base, l.qty_milli,
    (EXISTS ( SELECT 1 FROM public.purchase r WHERE (r.reverses_id = p.id))) AS is_reversed,
    p.plant_id
   FROM ((((public.purchase p
     JOIN public.supplier s ON ((s.id = p.supplier_id)))
     JOIN public.purchase_line l ON ((l.purchase_id = p.id)))
     JOIN public.component c ON ((c.id = l.component_id)))
     JOIN public.purchase_unit u ON ((u.id = l.purchase_unit_id)))
  WHERE p.reverses_id IS NULL
    AND (ctx.role() = ANY (ARRAY['owner'::text, 'support'::text, 'partner'::text, 'plant'::text]) OR ctx.actor_role() = 'office_purchases')
    AND (ctx.plant_scope() IS NULL OR p.plant_id IS NULL OR p.plant_id = ctx.plant_scope());
--> statement-breakpoint

-- The owner account is protected: it cannot change role, and an app_admin acting on the database cannot touch it.
CREATE FUNCTION public.user_owner_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- The break-glass paths (the migrator and the database superuser, server-side only) are not the application's.
  IF session_user IN ('belgobeton_migrator', 'postgres') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'owner' THEN
      RAISE EXCEPTION 'the owner account cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.role = 'owner' AND NEW.role <> 'owner' THEN
    RAISE EXCEPTION 'the owner account cannot be downgraded' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.role = 'owner' AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'the owner account cannot be disabled' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.role = 'owner' AND nullif(current_setting('app.role', true), '') = 'app_admin' THEN
    RAISE EXCEPTION 'an app_admin cannot change the owner account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.user_owner_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER user_owner_guard BEFORE UPDATE OR DELETE ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.user_owner_guard();
--> statement-breakpoint

-- Sales and purchases are two offices behind one policy role. The definer doors of each side refuse the other.
DO $$
DECLARE
  r record;
  v_call text;
  v_grantees text;
  v_table boolean;
  v_deny text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_arguments(p.oid) AS decl, pg_get_function_result(p.oid) AS res,
           (SELECT string_agg(a, ', ' ORDER BY ord) FROM unnest(p.proargnames, coalesce(p.proargmodes, array_fill('i'::"char", ARRAY[cardinality(p.proargnames)]))) WITH ORDINALITY AS t(a, m, ord) WHERE m IN ('i', 'b', 'v')) AS names,
           x.deny
      FROM pg_proc p
      JOIN (VALUES
        ('create_invoice', 'office_purchases'), ('create_invoice_from_deliveries', 'office_purchases'),
        ('create_order', 'office_purchases'), ('create_quote', 'office_purchases'),
        ('allocate_to_client', 'office_purchases'), ('allocate_to_order', 'office_purchases'),
        ('create_supplier_invoice', 'office_sales'), ('attach_supplier_invoice_file', 'office_sales'),
        ('allocate_to_purchase', 'office_sales'), ('allocate_to_supplier_invoice', 'office_sales'),
        ('record_receipt_lines', 'office_sales'), ('record_receipt', 'office_sales')
      ) AS x(name, deny) ON x.name = p.proname
     WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
  LOOP
    v_call := r.proname || '(' || r.names || ')';
    v_table := r.res LIKE 'TABLE(%';
    SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, ', ')
      INTO v_grantees
      FROM pg_proc p2, aclexplode(p2.proacl) a
     WHERE p2.oid = r.oid AND a.grantee <> p2.proowner AND a.grantee <> 0;
    EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I',
                   r.proname, (SELECT pg_get_function_identity_arguments(r.oid)), r.proname || '__inner');
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, belgobeton_app, belgobeton_system, belgobeton_seed',
                   r.proname || '__inner', (SELECT pg_get_function_identity_arguments(r.oid)));
    EXECUTE format(
      'CREATE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path = '''' AS $f$
       BEGIN
         IF ctx.actor_role() = %L THEN
           RAISE EXCEPTION ''%%: role %% may not use this door'', %L, ctx.actor_role() USING ERRCODE = ''insufficient_privilege'';
         END IF;
         %s
       END $f$',
      r.proname, r.decl, r.res, r.deny, r.proname,
      CASE WHEN v_table THEN format('RETURN QUERY SELECT * FROM public.%s__inner(%s);', r.proname, r.names)
           ELSE format('RETURN public.%s__inner(%s);', r.proname, r.names) END);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC', r.proname,
                   (SELECT pg_get_function_identity_arguments(r.oid)));
    IF v_grantees IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO %s', r.proname,
                     (SELECT pg_get_function_identity_arguments(r.oid)), v_grantees);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- The accountant reads the invoices with their amounts (REQUIREMENTS-V1 §3.8, provisional): invoices, their lines, avoirs,
-- the company profile. Nothing else: no treasury, cheques, loans, balances, clients' contacts.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice', 'invoice_line', 'avoir', 'company_profile'] LOOP
    EXECUTE format('CREATE POLICY accountant_read ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''accountant'')', t);
  END LOOP;
END $$;
