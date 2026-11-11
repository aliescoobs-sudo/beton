-- T11 (decision 211): the HISTORY layer. Imported deliveries and expenses from the company's monthly Excel files live in their own schema:
-- they never touch live stock, invoices, the ledger, trips, the plant board or dispatch. Reports, client statements (quantities only) and
-- analytics read them through the doors below. Forward migration; nothing applied is edited.
--   * FORCE row-level security on every table; the tables are readable by the owner (and app_admin) only, plant managers and the accountant
--     read ONLY through SECURITY DEFINER doors that validate the actor (ctx.actor_role() raises for a role that does not match the account).
--   * history.delivery / history.expense are insert-only (never updated, deleted or truncated); a rollback marks the BATCH, rows stay.
--   * A row with no plant is never shown to a plant manager (decision 207).
CREATE SCHEMA history;
--> statement-breakpoint
REVOKE ALL ON SCHEMA history FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA history TO belgobeton_app;
--> statement-breakpoint

CREATE TABLE history.batch (
  id             uuid PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('deliveries', 'expenses')),
  plant_id       uuid REFERENCES public.plant (id),
  set_sha        text NOT NULL CHECK (set_sha ~ '^[0-9a-f]{64}$'),
  status         text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'applied', 'rolled_back')),
  files          integer NOT NULL CHECK (files BETWEEN 1 AND 200),
  -- per month: rows read, litres read, rows and litres quarantined (numbers only, no cell)
  read_stats     jsonb NOT NULL DEFAULT '{}',
  counts         jsonb NOT NULL DEFAULT '{}',
  operation      text,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by     uuid,
  applied_at     timestamptz,
  rolled_back_by uuid,
  rolled_back_at timestamptz
);
--> statement-breakpoint
-- one live (staged or applied) batch per set of files; a rolled-back one lets the same files be staged again
CREATE UNIQUE INDEX history_batch_live_set ON history.batch (set_sha, kind) WHERE status <> 'rolled_back';
--> statement-breakpoint

CREATE TABLE history.label_map (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('client', 'truck', 'driver', 'type', 'pump', 'category')),
  key        text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  label      text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  uses       integer NOT NULL DEFAULT 0,
  -- pending: undecided (blocks the apply). mapped: to a record (client, truck, driver) or a canonical code (type, pump, category).
  -- new: a client to create at apply. label_only: keep the label, no record. unknown: truck/type/pump/category with no answer.
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'mapped', 'new', 'label_only', 'unknown')),
  client_id  uuid REFERENCES public.client (id),
  truck_id   uuid REFERENCES public.truck (id),
  driver_id  uuid REFERENCES public.driver (id),
  canonical  text CHECK (canonical IS NULL OR length(canonical) BETWEEN 1 AND 40),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by uuid,
  decided_at timestamptz,
  UNIQUE (kind, key),
  CHECK (status <> 'mapped' OR (kind = 'client' AND client_id IS NOT NULL) OR (kind = 'truck' AND truck_id IS NOT NULL)
         OR (kind = 'driver' AND driver_id IS NOT NULL) OR (kind IN ('type', 'pump', 'category') AND canonical IS NOT NULL)),
  CHECK (status <> 'new' OR kind = 'client'),
  CHECK (status <> 'label_only' OR kind IN ('client', 'driver'))
);
--> statement-breakpoint

CREATE TABLE history.quarantine (
  id         uuid PRIMARY KEY,
  set_sha    text NOT NULL CHECK (set_sha ~ '^[0-9a-f]{64}$'),
  kind       text NOT NULL CHECK (kind IN ('deliveries', 'expenses')),
  plant_id   uuid REFERENCES public.plant (id),
  file_ord   integer NOT NULL CHECK (file_ord >= 1),
  sheet_pos  integer NOT NULL CHECK (sheet_pos >= 1),
  row_no     integer NOT NULL CHECK (row_no >= 1),
  -- a fixed phrase: NO_DATE, NO_VOLUME, BAD_DATE, BAD_VOLUME, BAD_AMOUNT ...
  reason     text NOT NULL CHECK (reason ~ '^[A-Z_]{3,40}$'),
  raw        jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'discarded')),
  fixed      jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by uuid,
  decided_at timestamptz,
  UNIQUE (set_sha, kind, file_ord, sheet_pos, row_no),
  CHECK (status <> 'fixed' OR fixed IS NOT NULL)
);
--> statement-breakpoint

CREATE TABLE history.delivery (
  id            uuid PRIMARY KEY,
  batch_id      uuid NOT NULL REFERENCES history.batch (id),
  source        text NOT NULL DEFAULT 'history_import' CHECK (source = 'history_import'),
  plant_id      uuid REFERENCES public.plant (id),
  delivery_date date NOT NULL,
  -- litres (m³ x 1000, at most three decimals); history carries quantity only, never a price
  volume_l      integer NOT NULL CHECK (volume_l > 0 AND volume_l <= 200000000),
  client_raw    text,
  client_id     uuid REFERENCES public.client (id),
  site_raw      text,
  type_raw      text,
  type_code     text,
  pump_mode     text NOT NULL CHECK (pump_mode IN ('pump', 'chute', 'unknown')),
  truck_raw     text,
  truck_id      uuid REFERENCES public.truck (id),
  driver_raw    text,
  driver_id     uuid REFERENCES public.driver (id),
  bl_raw        text,
  bl_suspect    boolean NOT NULL DEFAULT false,
  tax_basis     text CHECK (tax_basis IN ('HT', 'TTC')),
  note          text,
  legacy        jsonb NOT NULL DEFAULT '{}',
  src_file      integer NOT NULL,
  src_sheet     integer NOT NULL,
  src_row       integer NOT NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX history_delivery_batch_idx ON history.delivery (batch_id);
--> statement-breakpoint
CREATE INDEX history_delivery_date_idx ON history.delivery (delivery_date);
--> statement-breakpoint
CREATE INDEX history_delivery_client_idx ON history.delivery (client_id) WHERE client_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE history.expense (
  id              uuid PRIMARY KEY,
  batch_id        uuid NOT NULL REFERENCES history.batch (id),
  source          text NOT NULL DEFAULT 'history_import' CHECK (source = 'history_import'),
  plant_id        uuid REFERENCES public.plant (id),
  -- the day when the sheet says it; otherwise only the month (the mapping names the month of a file with no date column)
  expense_date    date,
  expense_month   text NOT NULL CHECK (expense_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  category_code   text NOT NULL,
  label_raw       text,
  -- millilitres (litres x 1000) when the text says litres, else null
  quantity_ml     bigint CHECK (quantity_ml IS NULL OR quantity_ml > 0),
  amount_centimes bigint NOT NULL CHECK (amount_centimes > 0 AND amount_centimes <= 9007199254740991),
  truck_raw       text,
  truck_id        uuid REFERENCES public.truck (id),
  legacy          jsonb NOT NULL DEFAULT '{}',
  src_file        integer NOT NULL,
  src_sheet       integer NOT NULL,
  src_row         integer NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX history_expense_batch_idx ON history.expense (batch_id);
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['batch', 'label_map', 'quarantine', 'delivery', 'expense'] LOOP
    EXECUTE format('ALTER TABLE history.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE history.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON history.%I FROM PUBLIC', t);
    EXECUTE format('CREATE POLICY definer_read ON history.%I FOR SELECT TO belgobeton_migrator USING (true)', t);
    -- the owner and the app_admin (ctx.role() = owner) read and write; nobody else reads a table directly
    EXECUTE format('CREATE POLICY owner_read ON history.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''owner'')', t);
    EXECUTE format('CREATE POLICY owner_insert ON history.%I FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() = ''owner'')', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON history.batch, history.label_map, history.quarantine TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON history.delivery, history.expense TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY owner_update ON history.batch FOR UPDATE TO belgobeton_app USING (ctx.role() = 'owner') WITH CHECK (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY owner_update ON history.label_map FOR UPDATE TO belgobeton_app USING (ctx.role() = 'owner') WITH CHECK (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY owner_update ON history.quarantine FOR UPDATE TO belgobeton_app USING (ctx.role() = 'owner') WITH CHECK (ctx.role() = 'owner');
--> statement-breakpoint

-- Plant scope as defence in depth: a plant-bound actor never reads or writes a row of another plant, nor a row with no plant.
CREATE POLICY plant_scope ON history.delivery AS RESTRICTIVE FOR ALL TO belgobeton_app
  USING (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope()) WITH CHECK (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope());
--> statement-breakpoint
CREATE POLICY plant_scope ON history.expense AS RESTRICTIVE FOR ALL TO belgobeton_app
  USING (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope()) WITH CHECK (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope());
--> statement-breakpoint

-- Insert-only rows; the batch can only move forward; staging rows keep their identity and their raw cells.
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON history.delivery FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint
CREATE TRIGGER immutable_table BEFORE TRUNCATE ON history.delivery FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON history.expense FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint
CREATE TRIGGER immutable_table BEFORE TRUNCATE ON history.expense FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint
CREATE FUNCTION history.no_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'history: % is never deleted (a rollback marks the batch)', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE OR TRUNCATE ON history.batch FOR EACH STATEMENT EXECUTE FUNCTION history.no_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE OR TRUNCATE ON history.label_map FOR EACH STATEMENT EXECUTE FUNCTION history.no_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete BEFORE DELETE OR TRUNCATE ON history.quarantine FOR EACH STATEMENT EXECUTE FUNCTION history.no_delete();
--> statement-breakpoint
CREATE FUNCTION history.batch_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.id, NEW.kind, NEW.plant_id, NEW.set_sha, NEW.files, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.kind, OLD.plant_id, OLD.set_sha, OLD.files, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'history.batch: only the status and its marks change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD.status = 'staged' AND NEW.status IN ('staged', 'applied')) OR (OLD.status = 'applied' AND NEW.status IN ('applied', 'rolled_back'))
          OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'history.batch: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER batch_guard BEFORE UPDATE ON history.batch FOR EACH ROW EXECUTE FUNCTION history.batch_guard();
--> statement-breakpoint
CREATE FUNCTION history.label_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.id, NEW.kind, NEW.key, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.kind, OLD.key, OLD.created_at) THEN
    RAISE EXCEPTION 'history.label_map: the key of a label does not change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION history.quarantine_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.id, NEW.set_sha, NEW.kind, NEW.file_ord, NEW.sheet_pos, NEW.row_no, NEW.reason, NEW.raw)
     IS DISTINCT FROM (OLD.id, OLD.set_sha, OLD.kind, OLD.file_ord, OLD.sheet_pos, OLD.row_no, OLD.reason, OLD.raw) THEN
    RAISE EXCEPTION 'history.quarantine: the quarantined row keeps its place and its raw cells' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER label_guard BEFORE UPDATE ON history.label_map FOR EACH ROW EXECUTE FUNCTION history.label_guard();
--> statement-breakpoint
CREATE TRIGGER quarantine_guard BEFORE UPDATE ON history.quarantine FOR EACH ROW EXECUTE FUNCTION history.quarantine_guard();
--> statement-breakpoint
SELECT audit.attach('history.batch');
--> statement-breakpoint
SELECT audit.attach('history.label_map');
--> statement-breakpoint
SELECT audit.attach('history.quarantine');
--> statement-breakpoint

-- The doors. Each validates the actor (ctx.actor_role() raises for a role that does not match the account), refuses a driver session, scopes a
-- plant manager to his plant (a row with no plant is not his), and returns quantities (deliveries) or amounts (expenses, owner/app_admin/accountant).
CREATE FUNCTION history.volume_report(p_from date, p_to date)
RETURNS TABLE (plant_id uuid, month text, type_code text, pump_mode text, rows bigint, volume_l bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role();
BEGIN
  IF ctx.driver_id() IS NOT NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'app_admin', 'plant', 'plant_manager') THEN
    RAISE EXCEPTION 'history.volume_report: role % may not read it', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.plant_id, to_char(d.delivery_date, 'YYYY-MM'), coalesce(d.type_code, '?'), d.pump_mode, count(*), sum(d.volume_l)::bigint
      FROM history.delivery d JOIN history.batch b ON b.id = d.batch_id AND b.status = 'applied'
     WHERE d.delivery_date BETWEEN p_from AND p_to
       AND (v_role IN ('owner', 'app_admin') OR (ctx.plant_scope() IS NOT NULL AND d.plant_id = ctx.plant_scope()))
     GROUP BY 1, 2, 3, 4 ORDER BY 2, 1, 3, 4;
END $$;
--> statement-breakpoint
CREATE FUNCTION history.client_volume(p_client uuid)
RETURNS TABLE (month text, rows bigint, volume_l bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role();
BEGIN
  IF ctx.driver_id() IS NOT NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'app_admin', 'plant', 'plant_manager') THEN
    RAISE EXCEPTION 'history.client_volume: role % may not read it', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT to_char(d.delivery_date, 'YYYY-MM'), count(*), sum(d.volume_l)::bigint
      FROM history.delivery d JOIN history.batch b ON b.id = d.batch_id AND b.status = 'applied'
     WHERE d.client_id = p_client
       AND (v_role IN ('owner', 'app_admin') OR (ctx.plant_scope() IS NOT NULL AND d.plant_id = ctx.plant_scope()))
     GROUP BY 1 ORDER BY 1;
END $$;
--> statement-breakpoint
CREATE FUNCTION history.expense_report(p_from date, p_to date)
RETURNS TABLE (plant_id uuid, month text, category_code text, rows bigint, amount_centimes bigint, quantity_ml bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text := ctx.actor_role();
BEGIN
  IF ctx.driver_id() IS NOT NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'app_admin', 'accountant') THEN
    RAISE EXCEPTION 'history.expense_report: role % may not read it', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT e.plant_id, e.expense_month, e.category_code, count(*), sum(e.amount_centimes)::bigint, sum(e.quantity_ml)::bigint
      FROM history.expense e JOIN history.batch b ON b.id = e.batch_id AND b.status = 'applied'
     WHERE e.expense_month BETWEEN to_char(p_from, 'YYYY-MM') AND to_char(p_to, 'YYYY-MM')
     GROUP BY 1, 2, 3 ORDER BY 2, 1, 3;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION history.volume_report(date, date), history.client_volume(uuid), history.expense_report(date, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION history.volume_report(date, date), history.client_volume(uuid), history.expense_report(date, date) TO belgobeton_app;
