-- ledger L13 (law 71.24): bounce, the 30-day regularization window, regularize, dispute. Structure only; the legal
-- window length is the constant 30 here and in ledger/domain/legal.ts (a test compares the two).
ALTER TABLE public.instrument_event
  ADD COLUMN regularization_deadline date,
  ADD COLUMN covering_instrument_id uuid REFERENCES public.payment_instrument (id),
  -- A bounce always carries its deadline (set by the guard), nothing else does.
  ADD CONSTRAINT instrument_event_deadline_check CHECK ((event = 'bounced') = (regularization_deadline IS NOT NULL)),
  -- Regularizing needs the instrument that covers the bounced one; no other event has one.
  ADD CONSTRAINT instrument_event_covering_check CHECK ((event = 'regularized') = (covering_instrument_id IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX instrument_event_covering_idx ON public.instrument_event (covering_instrument_id)
  WHERE covering_instrument_id IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.instrument_event_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i      public.payment_instrument%ROWTYPE;
  v_cov    public.payment_instrument%ROWTYPE;
  v_last   public.instrument_event%ROWTYPE;
  v_state  text;
  v_kind   text;
  v_role   text := ctx.role();
BEGIN
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = NEW.instrument_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instrument_event: unknown instrument' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_last FROM public.instrument_event WHERE instrument_id = NEW.instrument_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(v_last.seq, 0) + 1;
  NEW.from_state := v_last.event;
  IF NOT public.instrument_transition_allowed(v_i.direction, v_i.method, NEW.from_state, NEW.event) THEN
    RAISE EXCEPTION 'instrument_event: illegal transition' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.from_state IS NULL AND NEW.at_date <> v_i.received_date THEN
    RAISE EXCEPTION 'instrument_event: the first event is dated the day of receipt' USING ERRCODE = 'check_violation';
  END IF;
  IF v_last.at_date IS NOT NULL AND NEW.at_date < v_last.at_date THEN
    RAISE EXCEPTION 'instrument_event: an event cannot be dated before the previous one' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event IN ('cancelled', 'disputed') AND NEW.reason IS NULL THEN
    RAISE EXCEPTION 'instrument_event: a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event IN ('deposited', 'cleared') THEN
    SELECT a.kind INTO v_kind FROM public.money_account a WHERE a.id = NEW.money_account_id;
    IF v_kind IS NULL THEN
      RAISE EXCEPTION 'instrument_event: an account is required' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.event = 'deposited' AND v_kind <> 'bank')
       OR (NEW.event = 'cleared' AND (v_kind = 'cash') <> (v_i.method = 'cash')) THEN
      RAISE EXCEPTION 'instrument_event: the account does not fit the method' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.money_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'instrument_event: this event has no account' USING ERRCODE = 'check_violation';
  END IF;

  -- The window of law 71.24: set here, never by the caller.
  NEW.regularization_deadline := CASE WHEN NEW.event = 'bounced' THEN NEW.at_date + 30 ELSE NULL END;
  IF NEW.event = 'regularized' THEN
    IF v_last.regularization_deadline IS NULL OR NEW.at_date > v_last.regularization_deadline THEN
      RAISE EXCEPTION 'instrument_event: the regularization window is closed' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_cov FROM public.payment_instrument WHERE id = NEW.covering_instrument_id;
    SELECT e.event INTO v_state FROM public.instrument_event e WHERE e.instrument_id = NEW.covering_instrument_id ORDER BY e.seq DESC LIMIT 1;
    IF NOT FOUND OR v_cov.id = v_i.id OR v_cov.direction <> 'in' OR v_cov.client_id IS DISTINCT FROM v_i.client_id
       OR v_cov.amount_centimes < v_i.amount_centimes OR v_cov.received_date > NEW.at_date
       OR v_state IN ('cancelled', 'bounced', 'disputed', 'regularized') THEN
      RAISE EXCEPTION 'instrument_event: the covering instrument does not cover the bounced one' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Office records what came in or went out, and a cash payment the day it happens; the owner confirms the rest.
  IF v_role = 'office' AND NOT (
       NEW.event IN ('received', 'issued')
       OR (NEW.event = 'cleared' AND v_i.method = 'cash' AND NEW.at_date = v_i.received_date)) THEN
    RAISE EXCEPTION 'instrument_event: office may only record receipt, issue and a same-day cash clearing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- The bank fee of a bounced cheque: a negative movement of the owner's, one per bounce event (source_id = the event).
CREATE POLICY money_movement_insert_expense ON public.money_movement FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id() AND source = 'expense' AND reverses_id IS NULL
              AND amount_centimes < 0 AND reason IS NOT NULL);
