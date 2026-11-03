-- Only the reviewed finance source doors gain this migrator read; runtime opening-balance rights do not change.
CREATE POLICY finance_opening_source_read ON public.opening_balance FOR SELECT TO belgobeton_migrator USING (ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint
-- Fail closed for an absent context as well as a disallowed role.
CREATE OR REPLACE FUNCTION finance.source_sales(p_from date,p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(x) FROM (
 SELECT jsonb_build_object('id',l.id,'date',i.invoice_date,'plantId',o.plant_id,'kind','concrete','amountCentimes',l.line_ht_centimes,'confirmed',coalesce(to_jsonb(o)->>'price_status','provisional')='confirmed') x
 FROM public.invoice_line l JOIN public.invoice i ON i.id=l.invoice_id JOIN public.delivery d ON d.id=l.delivery_id JOIN public.sales_order o ON o.id=d.order_id WHERE i.invoice_date BETWEEN p_from AND p_to
 UNION ALL
 SELECT jsonb_build_object('id',a.id,'date',a.avoir_date,'plantId',o.plant_id,'kind','concrete','amountCentimes',-a.total_ht_centimes,'confirmed',coalesce(to_jsonb(o)->>'price_status','provisional')='confirmed')
 FROM public.avoir a JOIN public.delivery d ON d.id=a.delivery_id JOIN public.sales_order o ON o.id=d.order_id WHERE a.avoir_date BETWEEN p_from AND p_to
 ) q),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance.source_consumption(p_from date,p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'date',m.movement_date,'plantId',m.plant_id,'kind','material','componentId',m.component_id,'componentName',c.name_fr,'baseUnit',c.base_unit,'qtyBase',m.qty_base,'amountCentimes',CASE WHEN m.source='reversal' THEN -v.amount_centimes ELSE v.amount_centimes END))
 FROM public.stock_movement m JOIN public.component c ON c.id=m.component_id LEFT JOIN public.stock_movement orig ON orig.id=m.reverses_id
 LEFT JOIN finance.finance_material_cost v ON v.movement_id=coalesce(m.reverses_id,m.id)
 WHERE (m.source='delivery' OR (m.source='reversal' AND orig.source='delivery')) AND m.movement_date BETWEEN p_from AND p_to),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance.source_accounts(p_as_of date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'label',a.label,'kind',a.kind,'balanceCentimes',coalesce(b.amount_centimes,0)+coalesce((SELECT sum(m.amount_centimes) FROM public.money_movement m WHERE m.account_id=a.id AND m.movement_date<=p_as_of AND (b.as_of IS NULL OR m.movement_date>b.as_of)),0)))
 FROM public.money_account a LEFT JOIN public.opening_balance b ON b.account_id=a.id),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance.source_flows() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
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

CREATE OR REPLACE FUNCTION finance.accounting_journal(p_from date,p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin','accountant') OR NOT finance.enabled() OR p_to<p_from OR p_to-p_from>366 THEN RAISE EXCEPTION 'export unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(j ORDER BY j->>'date', j->>'number') FROM (
 SELECT jsonb_build_object('journal','sales','number',i.number,'date',i.invoice_date,'party',i.client_name,'ice',i.client_ice,'creditNoteOf',(SELECT number FROM public.invoice WHERE id=i.credit_note_of),'lineHtCentimes',(SELECT coalesce(sum(il.line_ht_centimes),0) FROM public.invoice_line il WHERE il.invoice_id=i.id),'htCentimes',i.total_ht_centimes,'vatCentimes',i.total_vat_centimes,'ttcCentimes',i.total_ttc_centimes,'vatRateBp',i.vat_rate_bp) j
 FROM public.invoice i WHERE i.invoice_date BETWEEN p_from AND p_to
 UNION ALL
 SELECT jsonb_build_object('journal','sales','number',a.number,'date',a.avoir_date,'party',i.client_name,'ice',i.client_ice,'creditNoteOf',i.number,'lineHtCentimes',-a.total_ht_centimes,'htCentimes',-a.total_ht_centimes,'vatCentimes',-a.total_vat_centimes,'ttcCentimes',-a.total_ttc_centimes,'vatRateBp',a.vat_rate_bp)
 FROM public.avoir a JOIN public.invoice i ON i.id=a.invoice_id WHERE a.avoir_date BETWEEN p_from AND p_to
 UNION ALL
 SELECT jsonb_build_object('journal','purchases','number',p.code,'date',p.order_date,'party',s.name,'supplierInvoiceNo',p.supplier_invoice_no,'htCentimes',p.total_ht_centimes,'vatCentimes',p.total_vat_centimes,'ttcCentimes',p.total_ttc_centimes,'vatRateBp',p.vat_rate_bp)
 FROM public.purchase p JOIN public.supplier s ON s.id=p.supplier_id WHERE p.payable_source='order' AND p.order_date BETWEEN p_from AND p_to
 UNION ALL
 SELECT jsonb_build_object('journal','purchases','number',i.code,'date',i.invoice_date,'party',s.name,'supplierInvoiceNo',i.supplier_invoice_no,'htCentimes',i.total_ht_centimes,'vatCentimes',i.total_vat_centimes,'ttcCentimes',i.total_ttc_centimes,'vatRateBp',i.vat_rate_bp)
 FROM public.supplier_invoice i JOIN public.supplier s ON s.id=i.supplier_id WHERE i.invoice_date BETWEEN p_from AND p_to AND (SELECT event FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id=i.id ORDER BY seq DESC LIMIT 1)='approved'
 ) q),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance.link_state(p_id uuid) RETURNS TABLE(state text,amount_centimes bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT e.event,i.amount_centimes FROM public.payment_instrument i CROSS JOIN LATERAL (SELECT ev.event FROM public.instrument_event ev WHERE ev.instrument_id=i.id ORDER BY seq DESC LIMIT 1) e WHERE i.id=p_id;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance.source_movements(p_from date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id','actual-ledger:'||m.id,'commitmentId','actual-ledger:'||m.id,'date',m.movement_date,'direction',CASE WHEN m.amount_centimes>0 THEN 'in' ELSE 'out' END,'amountCentimes',abs(m.amount_centimes),'source','schedule')) FROM public.money_movement m WHERE m.movement_date>=p_from),'[]'::jsonb);
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance.write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR ctx.user_id() IS NULL OR NEW.created_by <> ctx.user_id() THEN
 RAISE EXCEPTION 'finance permission denied' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME <> 'finance_setting' AND NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 IF current_setting('app.finance_step_up',true) IS DISTINCT FROM 'verified' THEN
 RAISE EXCEPTION 'finance step-up required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE FUNCTION finance.steel_account_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.money_account a WHERE a.id=NEW.account_id AND a.kind='cash') THEN RAISE EXCEPTION 'steel proceeds need a cash account' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER steel_account_guard BEFORE INSERT ON finance.finance_steel FOR EACH ROW EXECUTE FUNCTION finance.steel_account_guard();
--> statement-breakpoint


-- Authorization runs before any integrity trigger, preventing guessed-amount oracles.
DROP TRIGGER write_guard ON finance.finance_setting;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_setting FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_category;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_category FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_allocation;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_allocation FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_entry;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_entry FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_obligation;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_obligation FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_payment;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_payment FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_instrument_link;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_instrument_link FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_steel;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_steel FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_facility;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_facility FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_material_cost;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_material_cost FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
DROP TRIGGER write_guard ON finance.finance_holder;
--> statement-breakpoint
CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_holder FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint
