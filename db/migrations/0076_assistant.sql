-- assistant A3 (SPEC-assistant §7, §9; AC-ASSIST-11, 14, 15): the tables of the in-app assistant and the audit kind of a human
-- confirmation. Structure only. The assistant owns these three tables and has no write access to any other business table.
-- Payloads (the pseudonymized question, the answer, the resolved parameters of a draft) are sealed by the application with
-- FIELD_ENCRYPTION_KEYS; the 90-day purge empties them and keeps the row and the audit chain.

-- The confirmation of a draft runs a normal service with the human as actor; the context carries the proposal so the audit
-- trail can tell the path ("ai_confirmed" and the proposal id, SPEC-assistant §7). Set by withRlsContext only.
CREATE FUNCTION ctx.ai_proposal_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.ai_proposal_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.ai_proposal_id() TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit.append(
  p_action text, p_table text, p_row_id text, p_before jsonb, p_after jsonb, p_reason text
) RETURNS bigint LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_id   bigint;
  v_at   timestamptz;
  v_kind text := CASE
    WHEN ctx.role() = 'system' THEN 'system'
    WHEN ctx.role() = 'anonymous' THEN 'anonymous'
    WHEN ctx.ai_proposal_id() IS NOT NULL THEN 'ai_confirmed'
    ELSE 'user' END;
  v_prev bytea;
  v_hash bytea;
BEGIN
  IF ctx.user_id() IS NULL THEN
    RAISE EXCEPTION 'audit: app.user_id is not set; writes need withRlsContext()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit: writes must run in READ COMMITTED (got %)', current_setting('transaction_isolation');
  END IF;

  PERFORM pg_advisory_xact_lock(7041001);
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

-- One question and its turn. Written once, at the end of the turn, by the asking user.
CREATE TABLE public.ai_interaction (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL,
  role              text NOT NULL CHECK (role IN ('owner', 'partner', 'office', 'plant', 'support')),
  locale            text NOT NULL CHECK (locale IN ('fr', 'ar')),
  provider          text NOT NULL CHECK (provider IN ('fake', 'anthropic', 'none')),
  model             text NOT NULL,
  -- Keyed hash (HMAC) of the raw question: tells that two questions were the same without keeping the text.
  question_hash     text NOT NULL CHECK (question_hash ~ '^[0-9a-f]{64}$'),
  -- The pseudonymized question and the answer as the person saw it, sealed. Emptied by the purge.
  question_enc      text,
  output_enc        text,
  outcome           text NOT NULL CHECK (outcome IN ('ok', 'rejected_schema', 'rejected_numbers', 'blocked_leak', 'fallback',
                                                     'refused', 'rate_limited', 'budget_stop', 'disabled')),
  tool_call_count   smallint NOT NULL DEFAULT 0 CHECK (tool_call_count BETWEEN 0 AND 6),
  tokens_in         integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out        integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  -- Whole micro-dollars: never a float.
  cost_micro_usd    bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  latency_ms        integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  payload_purged_at timestamptz
);
--> statement-breakpoint
CREATE INDEX ai_interaction_user_idx ON public.ai_interaction (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX ai_interaction_month_idx ON public.ai_interaction (created_at);
--> statement-breakpoint

-- Every tool call of a turn: its name, the validated arguments (codes, dates, quantities, placeholders: no name), the row count.
CREATE TABLE public.ai_tool_call (
  id             uuid PRIMARY KEY,
  interaction_id uuid NOT NULL REFERENCES public.ai_interaction (id),
  user_id        uuid NOT NULL,
  seq            smallint NOT NULL CHECK (seq BETWEEN 1 AND 6),
  tool           text NOT NULL CHECK (tool ~ '^[a-z_]{1,40}$'),
  args           jsonb NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('ok', 'permission_denied', 'invalid_args', 'error', 'blocked_leak')),
  row_count      integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interaction_id, seq)
);
--> statement-breakpoint

-- A draft: what a human may confirm. Nothing here is a business record.
CREATE TABLE public.ai_proposal (
  id             uuid PRIMARY KEY,
  interaction_id uuid NOT NULL REFERENCES public.ai_interaction (id),
  user_id        uuid NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner', 'partner', 'office', 'plant')),
  action         text NOT NULL CHECK (action IN ('plan_order', 'record_payment', 'create_purchase', 'record_return', 'invoice_from_bls')),
  -- The resolved parameters (JSON), sealed: they may hold an amount the person typed.
  params_enc     text,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'confirming', 'confirmed', 'rejected', 'expired', 'failed')),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  -- The document the confirmation created (an invoice or order number, a BL number): a number, never an amount.
  result_ref     text CHECK (result_ref IS NULL OR result_ref ~ '^[A-Za-z0-9/_-]{1,40}$')
);
--> statement-breakpoint
CREATE INDEX ai_proposal_user_idx ON public.ai_proposal (user_id, created_at DESC);
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_interaction', 'ai_tool_call', 'ai_proposal'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO belgobeton_app', t);
    -- The system actor reads, to empty payloads after 90 days and to re-seal them on a key rotation, and may touch nothing else.
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_system', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT UPDATE (question_enc, output_enc, payload_purged_at) ON public.ai_interaction TO belgobeton_system;
--> statement-breakpoint
GRANT UPDATE (params_enc) ON public.ai_proposal TO belgobeton_system;
--> statement-breakpoint
-- The asking user alone moves its draft along; the guard below allows only the legal steps.
GRANT UPDATE (status, decided_at, result_ref) ON public.ai_proposal TO belgobeton_app;
--> statement-breakpoint

-- Own rows only, for every role including the owner: what a person asked is that person's. The owner and support see the audit trail.
CREATE POLICY ai_interaction_read ON public.ai_interaction FOR SELECT TO belgobeton_app
  USING (user_id = ctx.user_id() OR ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY ai_interaction_read_system ON public.ai_interaction FOR SELECT TO belgobeton_system
  USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY ai_interaction_insert ON public.ai_interaction FOR INSERT TO belgobeton_app
  WITH CHECK (user_id = ctx.user_id() AND role = ctx.role());
--> statement-breakpoint
CREATE POLICY ai_interaction_purge ON public.ai_interaction FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint

CREATE POLICY ai_tool_call_read ON public.ai_tool_call FOR SELECT TO belgobeton_app
  USING (user_id = ctx.user_id() OR ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY ai_tool_call_read_system ON public.ai_tool_call FOR SELECT TO belgobeton_system
  USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY ai_tool_call_insert ON public.ai_tool_call FOR INSERT TO belgobeton_app
  WITH CHECK (user_id = ctx.user_id()
              AND EXISTS (SELECT 1 FROM public.ai_interaction i WHERE i.id = interaction_id AND i.user_id = ctx.user_id()));
--> statement-breakpoint

CREATE POLICY ai_proposal_read ON public.ai_proposal FOR SELECT TO belgobeton_app
  USING (user_id = ctx.user_id() OR ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY ai_proposal_read_system ON public.ai_proposal FOR SELECT TO belgobeton_system
  USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY ai_proposal_insert ON public.ai_proposal FOR INSERT TO belgobeton_app
  WITH CHECK (user_id = ctx.user_id() AND role = ctx.role() AND ctx.role() IN ('owner', 'partner', 'office', 'plant')
              AND status = 'pending' AND decided_at IS NULL AND result_ref IS NULL
              AND expires_at <= now() + interval '24 hours 1 minute'
              AND EXISTS (SELECT 1 FROM public.ai_interaction i WHERE i.id = interaction_id AND i.user_id = ctx.user_id()));
--> statement-breakpoint
CREATE POLICY ai_proposal_update ON public.ai_proposal FOR UPDATE TO belgobeton_app
  USING (user_id = ctx.user_id()) WITH CHECK (user_id = ctx.user_id());
--> statement-breakpoint
CREATE POLICY ai_proposal_rekey ON public.ai_proposal FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint

-- A proposal moves one way: pending, then confirming (claimed by its owner, once), then confirmed or failed; or pending to rejected
-- or expired. It cannot be confirmed after it expired, and nothing but the status, the instant and the resulting number changes.
CREATE FUNCTION public.ai_proposal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF ctx.role() = 'system' THEN
    -- Key rotation: only the sealed parameters change.
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.result_ref IS DISTINCT FROM OLD.result_ref THEN
      RAISE EXCEPTION 'ai_proposal: the system may only re-seal the parameters' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.params_enc IS DISTINCT FROM OLD.params_enc OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.interaction_id IS DISTINCT FROM OLD.interaction_id OR NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'ai_proposal: a change is a new proposal' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (
       (OLD.status = 'pending' AND NEW.status IN ('confirming', 'rejected', 'expired'))
    OR (OLD.status = 'confirming' AND NEW.status IN ('confirmed', 'failed'))
    OR (NEW.status = OLD.status AND NEW.status = 'confirmed' AND OLD.result_ref IS NULL AND NEW.result_ref IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'ai_proposal: % to % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'confirming' AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'ai_proposal: expired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_proposal_guard BEFORE UPDATE ON public.ai_proposal
  FOR EACH ROW EXECUTE FUNCTION public.ai_proposal_guard();
--> statement-breakpoint

-- Support reads like everyone else here: its own questions only (the registry names a support_read policy on every readable table).
CREATE POLICY support_read ON public.ai_interaction FOR SELECT TO belgobeton_app
  USING (ctx.role() = 'support' AND user_id = ctx.user_id());
--> statement-breakpoint
CREATE POLICY support_read ON public.ai_tool_call FOR SELECT TO belgobeton_app
  USING (ctx.role() = 'support' AND user_id = ctx.user_id());
--> statement-breakpoint
CREATE POLICY support_read ON public.ai_proposal FOR SELECT TO belgobeton_app
  USING (ctx.role() = 'support' AND user_id = ctx.user_id());
--> statement-breakpoint
SELECT audit.attach('public.ai_interaction');
--> statement-breakpoint
SELECT audit.attach('public.ai_tool_call');
--> statement-breakpoint
SELECT audit.attach('public.ai_proposal');
