-- Hash chain over audit_event (SPEC-platform-security §6):
--   hash = sha256(prev_hash || canonical(event)), computed under an advisory lock so ids and the chain agree.
-- The canonical form must match canonicalAuditEvent() in src/modules/platform-security/domain/audit-canonical.ts.

CREATE FUNCTION audit.field(v text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN v IS NULL THEN '-' ELSE octet_length(v)::text || ':' || v END
$$;
--> statement-breakpoint
CREATE FUNCTION audit.micros(ts timestamptz) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (extract(epoch FROM ts) * 1000000)::bigint::text
$$;
--> statement-breakpoint
CREATE FUNCTION audit.canonical_parts(
  p_id bigint, p_at timestamptz, p_sim_at timestamptz, p_actor uuid, p_kind text, p_request text,
  p_table text, p_row_id text, p_action text, p_before jsonb, p_after jsonb, p_reason text
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT concat_ws('|',
    audit.field(p_id::text), audit.field(audit.micros(p_at)), audit.field(audit.micros(p_sim_at)),
    audit.field(p_actor::text), audit.field(p_kind), audit.field(p_request), audit.field(p_table),
    audit.field(p_row_id), audit.field(p_action), audit.field(p_before::text), audit.field(p_after::text),
    audit.field(p_reason))
$$;
--> statement-breakpoint
CREATE FUNCTION audit.canonical(e public.audit_event) RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT audit.canonical_parts(e.id, e.at, e.sim_at, e.actor_user_id, e.actor_kind, e.request_id,
    e.table_name, e.row_id, e.action, e.before, e.after, e.reason)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.append(
  p_action text, p_table text, p_row_id text, p_before jsonb, p_after jsonb, p_reason text
) RETURNS bigint LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_id   bigint;
  v_at   timestamptz;
  v_kind text := CASE WHEN ctx.role() = 'system' THEN 'system' ELSE 'user' END;
  v_prev bytea;
  v_hash bytea;
BEGIN
  IF ctx.user_id() IS NULL THEN
    RAISE EXCEPTION 'audit: app.user_id is not set; writes need withRlsContext()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Under REPEATABLE READ/SERIALIZABLE the snapshot predates the lock and could miss the latest hash.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit: writes must run in READ COMMITTED (got %)', current_setting('transaction_isolation');
  END IF;

  PERFORM pg_advisory_xact_lock(7041001);  -- one chain writer at a time, until commit/rollback
  SELECT hash INTO v_prev FROM public.audit_event ORDER BY id DESC LIMIT 1;
  v_id := nextval(pg_get_serial_sequence('public.audit_event', 'id'));
  v_at := clock_timestamp();
  v_hash := sha256(coalesce(v_prev, ''::bytea) || convert_to(audit.canonical_parts(
    v_id, v_at, ctx.sim_at(), ctx.user_id(), v_kind, ctx.request_id(),
    p_table, p_row_id, p_action, p_before, p_after, p_reason), 'UTF8'));

  INSERT INTO public.audit_event
    (id, at, sim_at, actor_user_id, actor_kind, request_id, table_name, row_id, action, before, after, reason, prev_hash, hash)
  OVERRIDING SYSTEM VALUE VALUES
    (v_id, v_at, ctx.sim_at(), ctx.user_id(), v_kind, ctx.request_id(),
     p_table, p_row_id, p_action, p_before, p_after, p_reason, v_prev, v_hash);
  RETURN v_id;
END $$;
--> statement-breakpoint
ALTER TABLE public.audit_event
  ALTER COLUMN hash SET NOT NULL,
  ADD CONSTRAINT audit_event_hash_sha256 CHECK (octet_length(hash) = 32),
  ADD CONSTRAINT audit_event_prev_hash_sha256 CHECK (prev_hash IS NULL OR octet_length(prev_hash) = 32);
--> statement-breakpoint
-- No forks: each hash is the predecessor of at most one event, and only one event starts the chain.
CREATE UNIQUE INDEX audit_event_prev_hash_unique ON public.audit_event (prev_hash) NULLS NOT DISTINCT;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION audit.field(text), audit.micros(timestamptz),
  audit.canonical_parts(bigint, timestamptz, timestamptz, uuid, text, text, text, text, text, jsonb, jsonb, text),
  audit.canonical(public.audit_event) FROM PUBLIC;
