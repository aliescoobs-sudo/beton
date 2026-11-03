-- C1: finance reads the R3 price state. R3 keeps it in public.order_price_status (not a column of sales_order): an order with no row
-- was never provisional; a row without confirmed_at is a provisional price still waiting for the owner. Revenue is confirmed only when
-- no such unconfirmed row exists, so a provisional order stays out of the management result and the report says it is incomplete
-- (fail closed, DECISIONS 151). The invoice guard of 0083 already stops an invoice on a provisional line; this is the second line.
CREATE OR REPLACE FUNCTION finance.source_sales(p_from date,p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(x) FROM (
 SELECT jsonb_build_object('id',l.id,'date',i.invoice_date,'plantId',o.plant_id,'kind','concrete','amountCentimes',l.line_ht_centimes,'confirmed',(ps.order_id IS NULL OR ps.confirmed_at IS NOT NULL)) x
 FROM public.invoice_line l JOIN public.invoice i ON i.id=l.invoice_id JOIN public.delivery d ON d.id=l.delivery_id JOIN public.sales_order o ON o.id=d.order_id
 LEFT JOIN public.order_price_status ps ON ps.order_id=o.id WHERE i.invoice_date BETWEEN p_from AND p_to
 UNION ALL
 SELECT jsonb_build_object('id',a.id,'date',a.avoir_date,'plantId',o.plant_id,'kind','concrete','amountCentimes',-a.total_ht_centimes,'confirmed',(ps.order_id IS NULL OR ps.confirmed_at IS NOT NULL))
 FROM public.avoir a JOIN public.delivery d ON d.id=a.delivery_id JOIN public.sales_order o ON o.id=d.order_id
 LEFT JOIN public.order_price_status ps ON ps.order_id=o.id WHERE a.avoir_date BETWEEN p_from AND p_to
 ) q),'[]'::jsonb);
END $$;
