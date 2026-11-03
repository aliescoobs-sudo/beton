-- Source cash movements must accompany a start-of-day opening;
--> statement-breakpoint
-- a cleared instrument is not a forecast item.
CREATE FUNCTION finance.link_state(p_id uuid) RETURNS TABLE(state text,amount_centimes bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF ctx.role() NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT e.event,i.amount_centimes FROM public.payment_instrument i CROSS JOIN LATERAL (SELECT ev.event FROM public.instrument_event ev WHERE ev.instrument_id=i.id ORDER BY seq DESC LIMIT 1) e WHERE i.id=p_id;
END $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION finance.link_state(uuid) TO belgobeton_app;
--> statement-breakpoint

CREATE FUNCTION finance.source_movements(p_from date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF ctx.role() NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id','actual-ledger:'||m.id,'commitmentId','actual-ledger:'||m.id,'date',m.movement_date,'direction',CASE WHEN m.amount_centimes>0 THEN 'in' ELSE 'out' END,'amountCentimes',abs(m.amount_centimes),'source','schedule')) FROM public.money_movement m WHERE m.movement_date>=p_from),'[]'::jsonb);
END $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION finance.source_movements(date) TO belgobeton_app;
--> statement-breakpoint

-- A paper instrument cannot later be allocated in ledger as well as linked to a finance commitment.
CREATE FUNCTION finance.prevent_second_allocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:'||NEW.instrument_id::text,0));
 IF EXISTS(SELECT 1 FROM finance.finance_instrument_link l WHERE l.instrument_id=NEW.instrument_id) THEN
 RAISE EXCEPTION 'instrument already linked to finance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER finance_allocation_exclusive BEFORE INSERT ON public.allocation FOR EACH ROW EXECUTE FUNCTION finance.prevent_second_allocation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance.payment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o finance.finance_obligation%ROWTYPE; i public.payment_instrument%ROWTYPE; used bigint;
BEGIN
 IF NEW.instrument_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:'||NEW.instrument_id::text,0)); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('finance:'||NEW.obligation_id::text,0));
 SELECT * INTO o FROM finance.finance_obligation WHERE id=NEW.obligation_id;
 SELECT coalesce(sum(amount_centimes),0) INTO used FROM finance.finance_payment WHERE obligation_id=o.id;
 IF TG_TABLE_NAME='finance_payment' THEN
 IF NEW.instrument_id IS NOT NULL THEN
 IF NOT EXISTS(SELECT 1 FROM finance.finance_instrument_link l WHERE l.instrument_id=NEW.instrument_id AND l.obligation_id=o.id) THEN RAISE EXCEPTION 'link instrument before settlement' USING ERRCODE='23514'; END IF;
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

--> statement-breakpoint

CREATE FUNCTION finance.holder_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE kind text;
BEGIN
 SELECT a.kind INTO kind FROM public.money_account a WHERE a.id=NEW.account_id;
 IF kind IS NULL OR ((NEW.holder='company_bank') <> (kind='bank')) THEN RAISE EXCEPTION 'holder/account mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER holder_guard BEFORE INSERT ON finance.finance_holder FOR EACH ROW EXECUTE FUNCTION finance.holder_guard();
--> statement-breakpoint
