-- Generic audit capture for business tables (SPEC-platform-security §6).
-- Every business table gets it with: SELECT audit.attach('public.<table>');

-- Row trigger: one event per inserted/updated row, actor from ctx. Raises without app.user_id,
-- which aborts the statement: no anonymous writes to audited tables.
CREATE FUNCTION audit.capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM audit.append(
    lower(TG_OP),
    TG_TABLE_NAME,
    to_jsonb(NEW) ->> 'id',
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
    to_jsonb(NEW),
    NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Called by migrations (as the table owner) to audit a table. Idempotent.
CREATE FUNCTION audit.attach(p_table regclass) RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER audit_capture AFTER INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()',
    p_table);
END $$;
--> statement-breakpoint
-- Service-level events only: data changes ('insert', 'update') may come only from the capture trigger.
CREATE OR REPLACE FUNCTION audit.record(
  p_action text, p_table text, p_row_id text, p_before jsonb, p_after jsonb, p_reason text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_action IN ('insert', 'update') THEN
    RAISE EXCEPTION 'audit.record: % events are written only by the capture trigger', p_action
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN audit.append(p_action, p_table, p_row_id, p_before, p_after, p_reason);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION audit.capture(), audit.attach(regclass) FROM PUBLIC;
