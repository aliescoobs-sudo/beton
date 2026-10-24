-- ledger L10 (DECISIONS 81): payment instruments (cash, cheque, LCN, transfer, incoming and outgoing), their append-only
-- events, and the cash movement a clearing writes. Everything is insert-only: no UPDATE, DELETE or TRUNCATE grant. The
-- current state is the last event's state (derived, never stored), so nothing can drift. The lifecycle (L9 table) is
-- enforced here by a guard trigger, and `cleared` writes exactly one signed movement through a SECURITY DEFINER trigger.
-- Money: the owner and support read; office writes blind (receive / issue, and a cash clearing on the day) and reads nothing.

CREATE TABLE public.payment_instrument (
  id              uuid PRIMARY KEY,
  direction       text   NOT NULL CHECK (direction IN ('in', 'out')),
  method          text   NOT NULL CHECK (method IN ('cash', 'cheque', 'lcn', 'transfer')),
  amount_centimes bigint NOT NULL CHECK (amount_centimes > 0),
  client_id       uuid   REFERENCES public.client (id),
  supplier_id     uuid   REFERENCES public.supplier (id),
  number          text   CHECK (number = btrim(number) AND length(number) BETWEEN 1 AND 40),
  bank            text   CHECK (bank = btrim(bank) AND length(bank) BETWEEN 1 AND 80),
  -- The date written on a cheque or LCN (post-dated when after received_date).
  written_date    date,
  -- The day it was received (incoming) or handed over (outgoing).
  received_date   date   NOT NULL,
  created_by      uuid   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((direction = 'in' AND client_id IS NOT NULL AND supplier_id IS NULL)
      OR (direction = 'out' AND supplier_id IS NOT NULL AND client_id IS NULL)),
  -- Paper (cheque, LCN) has a number and a written date; cash has neither; a transfer may carry a reference.
  CHECK (CASE WHEN method IN ('cheque', 'lcn') THEN number IS NOT NULL AND written_date IS NOT NULL
              WHEN method = 'cash' THEN number IS NULL AND written_date IS NULL AND bank IS NULL
              ELSE written_date IS NULL END)
);
--> statement-breakpoint
-- The same cheque or LCN cannot be entered twice.
CREATE UNIQUE INDEX payment_instrument_paper_idx ON public.payment_instrument (direction, method, lower(coalesce(bank, '')), number)
  WHERE method IN ('cheque', 'lcn');
--> statement-breakpoint
CREATE INDEX payment_instrument_client_idx ON public.payment_instrument (client_id) WHERE client_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX payment_instrument_supplier_idx ON public.payment_instrument (supplier_id) WHERE supplier_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE public.instrument_event (
  id               uuid PRIMARY KEY,
  instrument_id    uuid NOT NULL REFERENCES public.payment_instrument (id),
  -- Set by the guard trigger, never by the caller.
  seq              integer NOT NULL,
  event            text NOT NULL CHECK (event IN ('received', 'issued', 'deposited', 'cleared', 'bounced', 'regularized', 'disputed', 'cancelled')),
  from_state       text,
  at_date          date NOT NULL,
  -- deposited: the bank account it goes to; cleared: the account the money lands in or leaves.
  money_account_id uuid REFERENCES public.money_account (id),
  reason           text CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instrument_id, seq)
);
--> statement-breakpoint

CREATE TABLE public.money_movement (
  id              uuid PRIMARY KEY,
  account_id      uuid   NOT NULL REFERENCES public.money_account (id),
  -- Signed: incoming is positive, outgoing negative.
  amount_centimes bigint NOT NULL CHECK (amount_centimes <> 0),
  movement_date   date   NOT NULL,
  source          text   NOT NULL CHECK (source IN ('instrument', 'expense', 'reversal')),
  source_id       uuid   NOT NULL,
  reverses_id     uuid   UNIQUE REFERENCES public.money_movement (id),
  reason          text   CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  created_by      uuid   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id),
  CHECK ((reverses_id IS NULL) = (source <> 'reversal')),
  CHECK (reverses_id IS NULL OR reason IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX money_movement_account_idx ON public.money_movement (account_id, movement_date);
--> statement-breakpoint

ALTER TABLE public.payment_instrument ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payment_instrument FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.instrument_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.instrument_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.money_movement ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.money_movement FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.payment_instrument, public.instrument_event, public.money_movement FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.payment_instrument, public.instrument_event, public.money_movement TO belgobeton_app;
--> statement-breakpoint

-- The SECURITY DEFINER functions run as the migrator, which FORCE RLS still subjects to policies: they get their own.
CREATE POLICY payment_instrument_definer_read ON public.payment_instrument FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY instrument_event_definer_read ON public.instrument_event FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY money_movement_definer_read ON public.money_movement FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY money_movement_definer_insert ON public.money_movement FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY money_account_definer_read ON public.money_account FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY supplier_definer_read ON public.supplier FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- The lifecycle table of ledger/domain/instrument.ts, in SQL. A test compares the two over every combination.
-- from_state NULL = the first event. `cancelled` is allowed from any non-final state.
CREATE FUNCTION public.instrument_transition_allowed(p_direction text, p_method text, p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_from IS NULL THEN p_to = CASE WHEN p_direction = 'in' THEN 'received' ELSE 'issued' END
    WHEN p_from IN ('cleared', 'regularized', 'disputed', 'cancelled') THEN false
    WHEN p_to = 'cancelled' THEN true
    WHEN p_direction = 'in' THEN
      CASE p_from
        WHEN 'received' THEN (p_to = 'deposited' AND p_method IN ('cheque', 'lcn'))
                          OR (p_to = 'cleared' AND p_method NOT IN ('cheque', 'lcn'))
        WHEN 'deposited' THEN p_method IN ('cheque', 'lcn') AND p_to IN ('cleared', 'bounced')
        WHEN 'bounced' THEN p_method IN ('cheque', 'lcn') AND p_to IN ('regularized', 'disputed')
        ELSE false
      END
    ELSE
      CASE p_from
        WHEN 'issued' THEN p_to = 'cleared' OR (p_to = 'bounced' AND p_method IN ('cheque', 'lcn'))
        ELSE false
      END
  END
$$;
--> statement-breakpoint

-- A new instrument: the party is active (an archived client or supplier gets no new document).
CREATE FUNCTION public.payment_instrument_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client c WHERE c.id = NEW.client_id AND c.status = 'active') THEN
    RAISE EXCEPTION 'payment_instrument: the client is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier s WHERE s.id = NEW.supplier_id AND s.status = 'active') THEN
    RAISE EXCEPTION 'payment_instrument: the supplier is not active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_instrument_guard BEFORE INSERT ON public.payment_instrument
  FOR EACH ROW EXECUTE FUNCTION public.payment_instrument_guard();
--> statement-breakpoint

-- Every instrument starts with its first event, in the same transaction (checked at commit).
CREATE FUNCTION public.payment_instrument_has_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.instrument_event e WHERE e.instrument_id = NEW.id) THEN
    RAISE EXCEPTION 'payment_instrument % has no first event', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_instrument_has_event AFTER INSERT ON public.payment_instrument
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payment_instrument_has_event();
--> statement-breakpoint

-- The guard on every event: legal transition, dates that do not go back, the right account, who may do what.
CREATE FUNCTION public.instrument_event_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i      public.payment_instrument%ROWTYPE;
  v_last   public.instrument_event%ROWTYPE;
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
CREATE TRIGGER instrument_event_guard BEFORE INSERT ON public.instrument_event
  FOR EACH ROW EXECUTE FUNCTION public.instrument_event_guard();
--> statement-breakpoint

-- `cleared` writes exactly one signed movement (incoming +, outgoing -). The unique (source, source_id) is the backstop.
CREATE FUNCTION public.instrument_cleared_movement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i public.payment_instrument%ROWTYPE;
BEGIN
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = NEW.instrument_id;
  INSERT INTO public.money_movement (id, account_id, amount_centimes, movement_date, source, source_id, created_by)
  VALUES (gen_random_uuid(), NEW.money_account_id,
          CASE WHEN v_i.direction = 'in' THEN v_i.amount_centimes ELSE -v_i.amount_centimes END,
          NEW.at_date, 'instrument', NEW.instrument_id, NEW.created_by);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER instrument_cleared_movement AFTER INSERT ON public.instrument_event
  FOR EACH ROW WHEN (NEW.event = 'cleared') EXECUTE FUNCTION public.instrument_cleared_movement();
--> statement-breakpoint

-- A reversing movement (a clearing entered by mistake, DECISIONS plan 4): it negates its original exactly, once, and a
-- reversal cannot be reversed. Only the owner may write one (policy below).
CREATE FUNCTION public.money_movement_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_o public.money_movement%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_o FROM public.money_movement WHERE id = NEW.reverses_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'money_movement: unknown movement to reverse' USING ERRCODE = 'check_violation';
  END IF;
  IF v_o.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'money_movement: a reversal cannot be reversed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.account_id <> v_o.account_id OR NEW.amount_centimes <> -v_o.amount_centimes OR NEW.source_id <> v_o.id THEN
    RAISE EXCEPTION 'money_movement: a reversal negates its original exactly' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER money_movement_guard BEFORE INSERT ON public.money_movement
  FOR EACH ROW EXECUTE FUNCTION public.money_movement_guard();
--> statement-breakpoint

-- The caisse (the first cash account created), for the roles that enter a cash payment without being able to read accounts.
CREATE FUNCTION public.default_cash_account() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'default_cash_account: role % may not use the caisse', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.id INTO v_id FROM public.money_account a WHERE a.kind = 'cash' ORDER BY a.created_at, a.id LIMIT 1;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'default_cash_account: there is no caisse' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.default_cash_account() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.default_cash_account() TO belgobeton_app;
--> statement-breakpoint

CREATE POLICY payment_instrument_read ON public.payment_instrument FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY payment_instrument_insert ON public.payment_instrument FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'office') AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY instrument_event_read ON public.instrument_event FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY instrument_event_insert ON public.instrument_event FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'office') AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY money_movement_read ON public.money_movement FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY money_movement_insert ON public.money_movement FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id() AND reverses_id IS NOT NULL);
--> statement-breakpoint
SELECT public.grant_support_read('public.payment_instrument');
--> statement-breakpoint
SELECT public.grant_support_read('public.instrument_event');
--> statement-breakpoint
SELECT public.grant_support_read('public.money_movement');
--> statement-breakpoint
SELECT audit.attach('public.payment_instrument');
--> statement-breakpoint
SELECT audit.attach('public.instrument_event');
--> statement-breakpoint
SELECT audit.attach('public.money_movement');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.is_money_table(p_table text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_table IN ('purchase_price', 'selling_price', 'sales_order', 'payment_plan_item', 'opening_balance',
                     'payment_instrument', 'instrument_event', 'money_movement')
$$;
