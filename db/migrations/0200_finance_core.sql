-- Finance is isolated in its own schema, with FORCE RLS, append-only rows and audited writes.
CREATE SCHEMA finance;
--> statement-breakpoint

REVOKE ALL ON SCHEMA finance FROM PUBLIC;
--> statement-breakpoint

GRANT USAGE ON SCHEMA finance TO belgobeton_app;
--> statement-breakpoint


CREATE TABLE finance.finance_setting (id uuid PRIMARY KEY, enabled boolean NOT NULL, leasing_treatment text NOT NULL CHECK (leasing_treatment IN ('expense','principal_interest')), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_setting ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_setting FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_setting FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_setting TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_setting FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_setting FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE FUNCTION finance.enabled() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT coalesce((SELECT enabled FROM finance.finance_setting ORDER BY created_at DESC, id DESC LIMIT 1),false)
$$;
--> statement-breakpoint

CREATE POLICY finance_read ON finance.finance_setting FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND true);
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_setting FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND true);
--> statement-breakpoint

 SELECT audit.attach('finance.finance_setting');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_setting FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_setting FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_category (id uuid PRIMARY KEY, code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 40), label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120), nature text NOT NULL CHECK (nature IN ('fixed','variable')), kind text NOT NULL CHECK (kind IN ('expense','pumping')), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_category ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_category FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_category FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_category TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_category FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_category FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_category FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_category FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_category');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_category FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_category FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_allocation (id uuid PRIMARY KEY, label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120), weights jsonb NOT NULL CHECK (jsonb_typeof(weights)='object'), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_allocation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_allocation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_allocation FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_allocation TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_allocation FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_allocation FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_allocation FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_allocation FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_allocation');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_allocation FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_allocation FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_entry (id uuid PRIMARY KEY, entry_date date NOT NULL, category_id uuid REFERENCES finance.finance_category(id), plant_id uuid REFERENCES public.plant(id), allocation_id uuid REFERENCES finance.finance_allocation(id), kind text NOT NULL CHECK (kind IN ('expense','pumping','financing','principal','leasing','steel_cost')), amount_centimes bigint NOT NULL CHECK (amount_centimes <> 0 AND abs(amount_centimes) <= 9007199254740991), source_ref text NOT NULL UNIQUE CHECK (length(source_ref) BETWEEN 1 AND 160), reverses_id uuid UNIQUE REFERENCES finance.finance_entry(id), reason text, CHECK (plant_id IS NULL OR allocation_id IS NULL), CHECK ((reverses_id IS NULL) = (amount_centimes > 0)), CHECK (reverses_id IS NULL OR length(reason) BETWEEN 1 AND 500), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_entry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_entry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_entry FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_entry TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_entry FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_entry FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_entry FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_entry FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_entry');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_entry FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_entry FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_obligation (id uuid PRIMARY KEY, due_date date NOT NULL, direction text NOT NULL CHECK (direction IN ('in','out')), amount_centimes bigint NOT NULL CHECK (amount_centimes > 0 AND amount_centimes <= 9007199254740991), source_ref text NOT NULL UNIQUE, entry_id uuid UNIQUE REFERENCES finance.finance_entry(id), label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_obligation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_obligation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_obligation FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_obligation TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_obligation FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_obligation FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_obligation FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_obligation FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_obligation');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_obligation FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_obligation FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_payment (id uuid PRIMARY KEY, obligation_id uuid NOT NULL REFERENCES finance.finance_obligation(id), payment_date date NOT NULL, amount_centimes bigint NOT NULL CHECK (amount_centimes > 0 AND amount_centimes <= 9007199254740991), account_id uuid NOT NULL REFERENCES public.money_account(id), instrument_id uuid UNIQUE REFERENCES public.payment_instrument(id), reference text NOT NULL UNIQUE CHECK (length(reference) BETWEEN 1 AND 160), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_payment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_payment FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_payment FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_payment TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_payment FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_payment FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_payment FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_payment FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_payment');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_payment FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_payment FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_instrument_link (id uuid PRIMARY KEY, obligation_id uuid NOT NULL REFERENCES finance.finance_obligation(id), instrument_id uuid NOT NULL UNIQUE REFERENCES public.payment_instrument(id), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_instrument_link ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_instrument_link FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_instrument_link FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_instrument_link TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_instrument_link FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_instrument_link FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_instrument_link FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_instrument_link FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_instrument_link');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_instrument_link FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_instrument_link FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_steel (id uuid PRIMARY KEY, delivery_date date NOT NULL, cash_centimes bigint NOT NULL CHECK (cash_centimes > 0), purchase_centimes bigint NOT NULL CHECK (purchase_centimes > cash_centimes AND purchase_centimes <= 9007199254740991), account_id uuid NOT NULL REFERENCES public.money_account(id), cheque_count integer NOT NULL CHECK (cheque_count BETWEEN 1 AND 3), reference text NOT NULL UNIQUE CHECK (length(reference) BETWEEN 1 AND 120), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_steel ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_steel FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_steel FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_steel TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_steel FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_steel FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_steel FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_steel FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_steel');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_steel FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_steel FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_facility (id uuid PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('bank','leasing')), label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120), start_date date NOT NULL, principal_centimes bigint NOT NULL CHECK (principal_centimes > 0), account_id uuid NOT NULL REFERENCES public.money_account(id), schedule jsonb NOT NULL CHECK (jsonb_typeof(schedule)='array'), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_facility ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_facility FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_facility FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_facility TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_facility FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_facility FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_facility FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_facility FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_facility');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_facility FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_facility FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_material_cost (id uuid PRIMARY KEY, movement_id uuid NOT NULL UNIQUE REFERENCES public.stock_movement(id), amount_centimes bigint NOT NULL CHECK (amount_centimes >= 0 AND amount_centimes <= 9007199254740991), price_centimes bigint NOT NULL CHECK (price_centimes > 0), price_base_qty bigint NOT NULL CHECK (price_base_qty > 0), valuation_reference text NOT NULL CHECK (length(valuation_reference) BETWEEN 1 AND 200), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_material_cost ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_material_cost FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_material_cost FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_material_cost TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_material_cost FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_material_cost FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_material_cost FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_material_cost FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_material_cost');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_material_cost FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_material_cost FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TABLE finance.finance_holder (id uuid PRIMARY KEY, account_id uuid NOT NULL UNIQUE REFERENCES public.money_account(id), holder text NOT NULL CHECK (holder IN ('owner','office','company_bank')), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

 ALTER TABLE finance.finance_holder ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

 ALTER TABLE finance.finance_holder FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

 REVOKE ALL ON finance.finance_holder FROM PUBLIC;
--> statement-breakpoint

 GRANT SELECT, INSERT ON finance.finance_holder TO belgobeton_app;
--> statement-breakpoint

 CREATE POLICY definer_read ON finance.finance_holder FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

 CREATE POLICY definer_insert ON finance.finance_holder FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

 CREATE POLICY finance_read ON finance.finance_holder FOR SELECT TO belgobeton_app USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

 CREATE POLICY finance_insert ON finance.finance_holder FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() IN ('owner','app_admin') AND created_by = ctx.user_id() AND finance.enabled());
--> statement-breakpoint

 SELECT audit.attach('finance.finance_holder');
--> statement-breakpoint

 CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_holder FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

 CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_holder FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

-- Defense in depth: finance values in audit payloads never reach legacy partner/support rights.
CREATE POLICY finance_audit_visibility ON public.audit_event AS RESTRICTIVE FOR SELECT TO belgobeton_app
 USING (table_name NOT LIKE 'finance\_%' ESCAPE '\' OR ctx.role() IN ('owner','app_admin'));
--> statement-breakpoint

CREATE FUNCTION finance.write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
 IF ctx.role() NOT IN ('owner','app_admin') OR ctx.user_id() IS NULL OR NEW.created_by <> ctx.user_id() THEN
 RAISE EXCEPTION 'finance permission denied' USING ERRCODE='42501'; END IF;
 IF current_setting('app.finance_step_up',true) IS DISTINCT FROM 'verified' THEN
 RAISE EXCEPTION 'finance step-up required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_setting FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_category FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_allocation FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_entry FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_obligation FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_payment FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_instrument_link FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_steel FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_facility FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_material_cost FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER write_guard BEFORE INSERT ON finance.finance_holder FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE FUNCTION finance.entry_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o finance.finance_entry%ROWTYPE; c finance.finance_category%ROWTYPE;
BEGIN
 IF NEW.reverses_id IS NOT NULL THEN
 SELECT * INTO o FROM finance.finance_entry WHERE id=NEW.reverses_id;
 IF o.id IS NULL OR o.reverses_id IS NOT NULL OR NEW.amount_centimes <> -o.amount_centimes OR NEW.kind <> o.kind
 OR NEW.plant_id IS DISTINCT FROM o.plant_id OR NEW.allocation_id IS DISTINCT FROM o.allocation_id OR NEW.category_id IS DISTINCT FROM o.category_id THEN
 RAISE EXCEPTION 'reversal must negate original exactly' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.category_id IS NOT NULL THEN
 SELECT * INTO c FROM finance.finance_category WHERE id=NEW.category_id;
 IF c.kind <> NEW.kind THEN RAISE EXCEPTION 'category kind mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind IN ('financing','steel_cost') AND (NEW.plant_id IS NOT NULL OR NEW.allocation_id IS NOT NULL) THEN
 RAISE EXCEPTION 'financing costs are central' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER entry_guard BEFORE INSERT ON finance.finance_entry FOR EACH ROW EXECUTE FUNCTION finance.entry_guard();
--> statement-breakpoint

CREATE FUNCTION finance.allocation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; v jsonb; total numeric := 0;
BEGIN
 FOR k,v IN SELECT * FROM jsonb_each(NEW.weights) LOOP
 IF jsonb_typeof(v)<>'number' OR v::numeric < 0 OR v::numeric <> trunc(v::numeric) OR v::numeric > 9007199254740991
 OR NOT EXISTS (SELECT 1 FROM public.plant WHERE id=k::uuid) THEN RAISE EXCEPTION 'invalid allocation key' USING ERRCODE='23514'; END IF;
 total := total+v::numeric;
 END LOOP;
 IF total<=0 THEN RAISE EXCEPTION 'empty allocation key' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER allocation_guard BEFORE INSERT ON finance.finance_allocation FOR EACH ROW EXECUTE FUNCTION finance.allocation_guard();
--> statement-breakpoint

CREATE FUNCTION finance.material_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.stock_movement%ROWTYPE;
BEGIN
 SELECT * INTO m FROM public.stock_movement WHERE id=NEW.movement_id;
 IF m.source <> 'delivery' OR m.qty_base >=0 OR m.id IS NULL OR NEW.amount_centimes <> round((-m.qty_base)::numeric*NEW.price_centimes/NEW.price_base_qty)::bigint THEN
 RAISE EXCEPTION 'valuation must equal recorded consumption times evidenced unit cost' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER material_guard BEFORE INSERT ON finance.finance_material_cost FOR EACH ROW EXECUTE FUNCTION finance.material_guard();
--> statement-breakpoint

CREATE FUNCTION finance.payment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o finance.finance_obligation%ROWTYPE; i public.payment_instrument%ROWTYPE; used bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('finance:'||NEW.obligation_id::text,0));
 SELECT * INTO o FROM finance.finance_obligation WHERE id=NEW.obligation_id;
 SELECT coalesce(sum(amount_centimes),0) INTO used FROM finance.finance_payment WHERE obligation_id=o.id;
 IF TG_TABLE_NAME='finance_payment' THEN
 IF NEW.instrument_id IS NOT NULL THEN
 SELECT * INTO i FROM public.payment_instrument WHERE id=NEW.instrument_id;
 IF i.id IS NULL OR i.direction<>o.direction OR i.amount_centimes<>NEW.amount_centimes OR NOT EXISTS (SELECT 1 FROM public.instrument_event e WHERE e.instrument_id=i.id AND e.event='cleared' AND e.at_date=NEW.payment_date AND e.money_account_id=NEW.account_id) THEN
 RAISE EXCEPTION 'payment must match cleared instrument' USING ERRCODE='23514'; END IF;
 ELSE
 IF EXISTS (SELECT 1 FROM finance.finance_instrument_link WHERE obligation_id=o.id) THEN
 RAISE EXCEPTION 'use the linked instrument to settle this obligation' USING ERRCODE='23514'; END IF;
 END IF;
 IF used+NEW.amount_centimes>o.amount_centimes THEN RAISE EXCEPTION 'obligation overpaid' USING ERRCODE='23514'; END IF;
 ELSE
 SELECT * INTO i FROM public.payment_instrument WHERE id=NEW.instrument_id;
 IF i.id IS NULL OR i.direction<>o.direction OR used>0 OR EXISTS (SELECT 1 FROM public.allocation a WHERE a.instrument_id=i.id) THEN
 RAISE EXCEPTION 'instrument already covers another commitment' USING ERRCODE='23514'; END IF;
 IF i.amount_centimes+coalesce((SELECT sum(p.amount_centimes) FROM finance.finance_instrument_link l JOIN public.payment_instrument p ON p.id=l.instrument_id WHERE l.obligation_id=o.id),0)>o.amount_centimes THEN
 RAISE EXCEPTION 'commitment over-covered' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER payment_guard BEFORE INSERT ON finance.finance_payment FOR EACH ROW EXECUTE FUNCTION finance.payment_guard();
--> statement-breakpoint

CREATE TRIGGER link_guard BEFORE INSERT ON finance.finance_instrument_link FOR EACH ROW EXECUTE FUNCTION finance.payment_guard();
--> statement-breakpoint
