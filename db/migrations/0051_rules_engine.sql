-- rules-engine R6 (SPEC-rules-engine §5, DECISIONS 81): what the engine remembers. The forecast, the alerts and the options
-- are computed on demand from the facts, so only three things are stored, all insert-only (no UPDATE, DELETE or TRUNCATE
-- grant) and all money data (owner and support read, only the owner writes; a reclassification and a decision are the
-- owner's, and the support role can never write):
--   alert          the identity of a condition (rule + subject) and the day it was first seen; never changed, it proves
--                  "detected N days ahead".
--   alert_event    what happened to it: detected, severity changed, resolved, reopened, reclassified (with a reason).
--                  The state of an alert is the fold of its events, so nothing can drift.
--   cash_decision  an option the owner confirmed (after a fresh second factor): the option, the numbers the engine computed
--                  for it, the draft message he will send himself. It moves no money by itself.

CREATE TABLE public.alert (
  id                uuid PRIMARY KEY,
  rule_id           text NOT NULL CHECK (rule_id IN (
                      'CASH-DEFICIT', 'CASH-DEFICIT-WORST', 'PAY-DUE', 'RCV-DUE', 'RCV-OVERDUE', 'CHQ-BOUNCED',
                      'STOCK-SHORTAGE', 'STOCK-LOW', 'LAW6921-RECEIVABLE', 'LAW6921-PAYABLE', 'INVOICE-MONTH-END',
                      'DAY-CONFLICT')),
  subject_key       text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 200),
  -- The business day (the clock's) and the real instant the engine first saw the condition.
  first_detected_on date NOT NULL,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,
  UNIQUE (rule_id, subject_key)
);
--> statement-breakpoint
CREATE TABLE public.alert_event (
  id                uuid PRIMARY KEY,
  alert_id          uuid NOT NULL REFERENCES public.alert (id),
  seq               integer NOT NULL CHECK (seq >= 1),
  kind              text NOT NULL CHECK (kind IN ('detected', 'resolved', 'reopened', 'severity_changed', 'reclassified')),
  -- The computed severity when the event was written (null on a resolution).
  severity          text CHECK (severity IN ('risk', 'urgent', 'important', 'probable')),
  -- reclassified: the severity the owner chose, with his reason.
  override_severity text CHECK (override_severity IN ('risk', 'urgent', 'important', 'probable')),
  reason            text CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  at_date           date NOT NULL,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_id, seq),
  CHECK (kind <> 'reclassified' OR (override_severity IS NOT NULL AND reason IS NOT NULL AND severity IS NOT NULL)),
  CHECK (kind = 'resolved' OR severity IS NOT NULL),
  CHECK (kind = 'reclassified' OR override_severity IS NULL)
);
--> statement-breakpoint
CREATE INDEX alert_event_alert_idx ON public.alert_event (alert_id, seq);
--> statement-breakpoint
CREATE TABLE public.cash_decision (
  id                 uuid PRIMARY KEY,
  -- The alert it answers: "RULE:subject".
  alert_key          text NOT NULL CHECK (length(alert_key) BETWEEN 3 AND 300),
  -- The engine's option id and the kinds it is made of (a pair has two).
  option_id          text NOT NULL CHECK (length(option_id) BETWEEN 1 AND 600),
  kinds              text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 4),
  target_date        date NOT NULL,
  -- What the deterministic engine computed, kept as the owner saw it (centimes and basis points).
  coverage_bp        integer NOT NULL CHECK (coverage_bp BETWEEN 0 AND 10000),
  gain_centimes      bigint NOT NULL,
  shortfall_centimes bigint NOT NULL CHECK (shortfall_centimes >= 0),
  -- What the option touches (document codes, counterparties, amounts, dates): data, never a sentence.
  details            jsonb NOT NULL,
  -- The message the owner will send himself (supplier, client or bank); the application sends nothing.
  draft_text         text CHECK (length(draft_text) <= 4000),
  decided_on         date NOT NULL,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX cash_decision_alert_idx ON public.cash_decision (alert_key, created_at);
--> statement-breakpoint

ALTER TABLE public.alert ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.alert FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.alert_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.alert_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.cash_decision ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.cash_decision FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.alert, public.alert_event, public.cash_decision FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.alert, public.alert_event, public.cash_decision TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY alert_read ON public.alert FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY alert_insert ON public.alert FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY alert_event_read ON public.alert_event FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY alert_event_insert ON public.alert_event FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY cash_decision_read ON public.cash_decision FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY cash_decision_insert ON public.cash_decision FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.alert');
--> statement-breakpoint
SELECT public.grant_support_read('public.alert_event');
--> statement-breakpoint
SELECT public.grant_support_read('public.cash_decision');
--> statement-breakpoint
SELECT audit.attach('public.alert');
--> statement-breakpoint
SELECT audit.attach('public.alert_event');
--> statement-breakpoint
SELECT audit.attach('public.cash_decision');
--> statement-breakpoint

-- Two guards the owner's session cannot get around: the sequence of an alert's events is gapless (so the fold cannot be
-- fooled by a skipped or re-ordered event), and an alert event cannot be written for a day before the alert was first seen.
CREATE FUNCTION public.alert_event_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_last integer;
  v_first date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('alert_event:' || NEW.alert_id::text, 0));
  SELECT coalesce(max(e.seq), 0) INTO v_last FROM public.alert_event e WHERE e.alert_id = NEW.alert_id;
  IF NEW.seq <> v_last + 1 THEN
    RAISE EXCEPTION 'alert_event: sequence conflict, retry' USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT a.first_detected_on INTO v_first FROM public.alert a WHERE a.id = NEW.alert_id;
  IF v_first IS NULL OR NEW.at_date < v_first THEN
    RAISE EXCEPTION 'alert_event: dated before the alert was first detected' USING ERRCODE = 'check_violation';
  END IF;
  IF v_last = 0 AND NEW.kind <> 'detected' THEN
    RAISE EXCEPTION 'alert_event: the first event is the detection' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER alert_event_guard BEFORE INSERT ON public.alert_event
  FOR EACH ROW EXECUTE FUNCTION public.alert_event_guard();
--> statement-breakpoint
-- The definer function reads alert as the migrator, which FORCE RLS subjects to a policy.
CREATE POLICY alert_definer_read ON public.alert FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY alert_event_definer_read ON public.alert_event FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement', 'allocation', 'opening_party_balance',
                     'purchase', 'purchase_line', 'purchase_plan_item', 'invoice', 'invoice_line', 'quote',
                     'alert', 'alert_event', 'cash_decision')
$$;
