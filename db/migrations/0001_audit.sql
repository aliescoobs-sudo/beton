-- Append-only audit log (SPEC-platform-security §6). Writes go only through audit.* functions.

-- New functions are not executable by PUBLIC unless a migration grants them.
ALTER DEFAULT PRIVILEGES FOR ROLE belgobeton_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
CREATE SCHEMA audit;
--> statement-breakpoint
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE public.audit_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  sim_at        timestamptz,
  actor_user_id uuid NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user', 'system', 'ai_confirmed')),
  request_id    text,
  table_name    text NOT NULL,
  row_id        text,
  action        text NOT NULL CHECK (action IN (
                  'insert', 'update', 'reverse', 'archive',
                  'login', 'login_failed', 'logout', 'permission_denied', 'export',
                  'ai_proposal', 'ai_confirmation', 'telegram_link', 'clock_advance')),
  before        jsonb,
  after         jsonb,
  reason        text,
  prev_hash     bytea,
  hash          bytea
);
--> statement-breakpoint
REVOKE ALL ON public.audit_event FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_delete BEFORE UPDATE OR DELETE ON public.audit_event
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON public.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint
-- The owner keeps only SELECT and INSERT; the triggers above also stop it if it re-grants itself.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.audit_event FROM belgobeton_migrator;
--> statement-breakpoint
-- Single write path. Actor, request and simulated time come from the transaction context (ctx.*).
CREATE FUNCTION audit.append(
  p_action text, p_table text, p_row_id text, p_before jsonb, p_after jsonb, p_reason text
) RETURNS bigint LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_id bigint;
BEGIN
  IF ctx.user_id() IS NULL THEN
    RAISE EXCEPTION 'audit: app.user_id is not set; writes need withRlsContext()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.audit_event (sim_at, actor_user_id, actor_kind, request_id, table_name, row_id, action, before, after, reason)
  VALUES (
    ctx.sim_at(), ctx.user_id(),
    CASE WHEN ctx.role() = 'system' THEN 'system' ELSE 'user' END,
    ctx.request_id(), p_table, p_row_id, p_action, p_before, p_after, p_reason)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
-- Service-level events (login, permission denied, AI confirmation…). Runs with the table owner's rights.
CREATE FUNCTION audit.record(
  p_action text, p_table text, p_row_id text, p_before jsonb, p_after jsonb, p_reason text
) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT audit.append(p_action, p_table, p_row_id, p_before, p_after, p_reason)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA audit FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA audit TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.record(text, text, text, jsonb, jsonb, text)
  TO belgobeton_app, belgobeton_auth, belgobeton_system;
