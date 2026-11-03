-- Narrow, reviewed source doors. No runtime code queries another module's tables.
CREATE FUNCTION finance.source_sales(p_from date, p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF ctx.role() NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'date',i.invoice_date,'plantId',o.plant_id,'kind','concrete','amountCentimes',l.line_ht_centimes,'confirmed',coalesce(to_jsonb(o)->>'price_status','provisional')='confirmed'))
 FROM public.invoice_line l JOIN public.invoice i ON i.id=l.invoice_id JOIN public.delivery d ON d.id=l.delivery_id JOIN public.sales_order o ON o.id=d.order_id
 WHERE i.invoice_date BETWEEN p_from AND p_to),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE FUNCTION finance.source_consumption(p_from date,p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF ctx.role() NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'date',m.movement_date,'plantId',m.plant_id,'kind','material','componentId',m.component_id,'qtyBase',m.qty_base,'amountCentimes',CASE WHEN m.source='reversal' THEN -v.amount_centimes ELSE v.amount_centimes END))
 FROM public.stock_movement m LEFT JOIN public.stock_movement orig ON orig.id=m.reverses_id
 LEFT JOIN finance.finance_material_cost v ON v.movement_id=coalesce(m.reverses_id,m.id)
 WHERE (m.source='delivery' OR (m.source='reversal' AND orig.source='delivery')) AND m.movement_date BETWEEN p_from AND p_to),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE FUNCTION finance.source_accounts(p_as_of date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF ctx.role() NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,'kind',a.kind,'balanceCentimes',coalesce(b.amount_centimes,0)+coalesce((SELECT sum(m.amount_centimes) FROM public.money_movement m WHERE m.account_id=a.id AND m.movement_date<=p_as_of AND (b.as_of IS NULL OR m.movement_date>b.as_of)),0)))
 FROM public.money_account a LEFT JOIN public.opening_balance b ON b.account_id=a.id),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE FUNCTION finance.source_flows() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
 IF ctx.role() NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 -- Allocated amounts are removed from schedules, then each instrument is counted once, including bounced outgoing liabilities.
 SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO result FROM (
 SELECT jsonb_build_object('id','instrument:'||i.id,'commitmentId',coalesce(l.obligation_id::text,'instrument:'||i.id),'date',coalesce(i.written_date,i.received_date),'issuedDate',i.received_date,'method',i.method,'direction',i.direction,'amountCentimes',i.amount_centimes,'source','instrument') x
 FROM public.payment_instrument i CROSS JOIN LATERAL (SELECT e.event FROM public.instrument_event e WHERE e.instrument_id=i.id ORDER BY seq DESC LIMIT 1) last
 LEFT JOIN finance.finance_instrument_link l ON l.instrument_id=i.id
 WHERE last.event NOT IN ('cleared','cancelled') AND (i.direction='out' OR last.event IN ('received','deposited'))
 UNION ALL
 SELECT jsonb_build_object('id','order:'||p.id,'commitmentId','order:'||p.id,'date',p.due_date,'direction','in','amountCentimes',p.amount_centimes-coalesce((SELECT sum(a.amount_centimes) FROM public.allocation a WHERE a.payment_plan_item_id=p.id),0),'source','schedule')
 FROM public.payment_plan_item p JOIN public.sales_order o ON o.id=p.order_id
 WHERE p.reverses_id IS NULL AND o.reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.sales_order r WHERE r.reverses_id=o.id) AND NOT EXISTS(SELECT 1 FROM public.payment_plan_item r WHERE r.reverses_id=p.id)
 UNION ALL
 SELECT jsonb_build_object('id','purchase:'||p.id,'commitmentId','purchase:'||p.id,'date',p.due_date,'direction','out','amountCentimes',p.amount_centimes-coalesce((SELECT sum(a.amount_centimes) FROM public.allocation a WHERE a.purchase_plan_item_id=p.id),0),'source','schedule')
 FROM public.purchase_plan_item p JOIN public.purchase o ON o.id=p.purchase_id
 WHERE p.reverses_id IS NULL AND o.reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.purchase r WHERE r.reverses_id=o.id) AND NOT EXISTS(SELECT 1 FROM public.purchase_plan_item r WHERE r.reverses_id=p.id)
 ) q;
 RETURN result;
END $$;
--> statement-breakpoint

-- Accountant reads document amounts only. It gets no treasury, balances, steel, loan or P&L door.
CREATE FUNCTION finance.accounting_journal(p_from date,p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF ctx.role() NOT IN ('owner','app_admin','accountant') OR NOT finance.enabled() OR p_to<p_from OR p_to-p_from>366 THEN RAISE EXCEPTION 'export unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(j ORDER BY j->>'date', j->>'number') FROM (
 SELECT jsonb_build_object('journal','sales','number',i.number,'date',i.invoice_date,'party',i.client_name,'ice',i.client_ice,'creditNoteOf',(SELECT number FROM public.invoice WHERE id=i.credit_note_of),'htCentimes',i.total_ht_centimes,'vatCentimes',i.total_vat_centimes,'ttcCentimes',i.total_ttc_centimes,'vatRateBp',i.vat_rate_bp) j
 FROM public.invoice i WHERE i.invoice_date BETWEEN p_from AND p_to
 UNION ALL
 SELECT jsonb_build_object('journal','purchases','number',p.code,'date',p.order_date,'party',s.name,'supplierInvoiceNo',p.supplier_invoice_no,'htCentimes',p.total_ht_centimes,'vatCentimes',p.total_vat_centimes,'ttcCentimes',p.total_ttc_centimes,'vatRateBp',p.vat_rate_bp)
 FROM public.purchase p JOIN public.supplier s ON s.id=p.supplier_id WHERE p.payable_source='order' AND p.order_date BETWEEN p_from AND p_to
 UNION ALL
 SELECT jsonb_build_object('journal','purchases','number',i.code,'date',i.invoice_date,'party',s.name,'supplierInvoiceNo',i.supplier_invoice_no,'htCentimes',i.total_ht_centimes,'vatCentimes',i.total_vat_centimes,'ttcCentimes',i.total_ttc_centimes,'vatRateBp',i.vat_rate_bp)
 FROM public.supplier_invoice i JOIN public.supplier s ON s.id=i.supplier_id WHERE i.invoice_date BETWEEN p_from AND p_to AND (SELECT event FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id=i.id ORDER BY seq DESC LIMIT 1)='approved'
 ) q),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE FUNCTION finance.steel_post() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE entry uuid := gen_random_uuid(); obligation uuid := gen_random_uuid(); idx integer; amount bigint; assigned bigint:=0;
BEGIN
 INSERT INTO finance.finance_entry(id,entry_date,kind,amount_centimes,source_ref,created_by) VALUES(entry,NEW.delivery_date,'steel_cost',NEW.purchase_centimes-NEW.cash_centimes,'steel:cost:'||NEW.id,NEW.created_by);
 INSERT INTO finance.finance_obligation(id,due_date,direction,amount_centimes,source_ref,label,created_by) VALUES(obligation,NEW.delivery_date,'in',NEW.cash_centimes,'steel:cash:'||NEW.id,NEW.reference,NEW.created_by);
 INSERT INTO finance.finance_payment(id,obligation_id,payment_date,amount_centimes,account_id,reference,created_by) VALUES(gen_random_uuid(),obligation,NEW.delivery_date,NEW.cash_centimes,NEW.account_id,'steel:cash:'||NEW.id,NEW.created_by);
 FOR idx IN 1..NEW.cheque_count LOOP
 amount:=CASE WHEN idx=NEW.cheque_count THEN NEW.purchase_centimes-assigned ELSE round(NEW.purchase_centimes::numeric/NEW.cheque_count)::bigint END; assigned:=assigned+amount;
 INSERT INTO finance.finance_obligation(id,due_date,direction,amount_centimes,source_ref,label,created_by)
 VALUES(gen_random_uuid(),(NEW.delivery_date+make_interval(months=>idx))::date,'out',amount,'steel:cheque:'||NEW.id||':'||idx,NEW.reference,NEW.created_by);
 END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint

CREATE TRIGGER steel_post AFTER INSERT ON finance.finance_steel FOR EACH ROW EXECUTE FUNCTION finance.steel_post();
--> statement-breakpoint

CREATE FUNCTION finance.facility_post() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE item jsonb; entry uuid; obligation uuid; total numeric:=0; idx integer:=0; last_date date:=NEW.start_date; p bigint; cost bigint; due date;
BEGIN
 IF jsonb_array_length(NEW.schedule)<1 OR jsonb_array_length(NEW.schedule)>600 THEN RAISE EXCEPTION 'invalid facility schedule' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(NEW.schedule) LOOP
 p:=(item->>'principalCentimes')::bigint; cost:=(item->>'costCentimes')::bigint; due:=(item->>'date')::date;
 IF p IS NULL OR cost IS NULL OR due IS NULL OR p<0 OR cost<0 OR p+cost<=0 OR due<last_date THEN RAISE EXCEPTION 'invalid facility item' USING ERRCODE='23514'; END IF;
 last_date:=due; total:=total+p; idx:=idx+1; entry:=gen_random_uuid();
 IF p>0 THEN INSERT INTO finance.finance_entry(id,entry_date,kind,amount_centimes,source_ref,created_by)
 VALUES(entry,due,CASE WHEN NEW.kind='leasing' THEN 'leasing' ELSE 'principal' END,p,'facility:principal:'||NEW.id||':'||idx,NEW.created_by); END IF;
 IF cost>0 THEN INSERT INTO finance.finance_entry(id,entry_date,kind,amount_centimes,source_ref,created_by)
 VALUES(gen_random_uuid(),due,'financing',cost,'facility:cost:'||NEW.id||':'||idx,NEW.created_by); END IF;
 INSERT INTO finance.finance_obligation(id,due_date,direction,amount_centimes,source_ref,label,created_by)
 VALUES(gen_random_uuid(),due,'out',p+cost,'facility:item:'||NEW.id||':'||idx,NEW.label,NEW.created_by);
 END LOOP;
 IF total<>NEW.principal_centimes THEN RAISE EXCEPTION 'facility principal mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.kind='bank' THEN
 obligation:=gen_random_uuid();
 INSERT INTO finance.finance_obligation(id,due_date,direction,amount_centimes,source_ref,label,created_by) VALUES(obligation,NEW.start_date,'in',NEW.principal_centimes,'facility:cash:'||NEW.id,NEW.label,NEW.created_by);
 INSERT INTO finance.finance_payment(id,obligation_id,payment_date,amount_centimes,account_id,reference,created_by) VALUES(gen_random_uuid(),obligation,NEW.start_date,NEW.principal_centimes,NEW.account_id,'facility:cash:'||NEW.id,NEW.created_by);
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint

CREATE TRIGGER facility_post AFTER INSERT ON finance.finance_facility FOR EACH ROW EXECUTE FUNCTION finance.facility_post();
--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA finance FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION finance.enabled(), finance.source_sales(date,date),finance.source_consumption(date,date),finance.source_accounts(date),finance.source_flows(),finance.accounting_journal(date,date) TO belgobeton_app;
--> statement-breakpoint
