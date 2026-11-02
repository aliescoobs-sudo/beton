-- §16.2 (REQUIREMENTS-V1 §3.3, §16.2): office_sales prints an invoice with its amounts and nothing else. Two reviewed doors:
-- the index (number, date, client, no figure) and one document (header, lines, advance), each for one invoice at a time.
-- Entering or printing never grants balances: there is no list with totals, no payment state, no client balance here.
CREATE FUNCTION public.invoice_print_index() RETURNS TABLE(id uuid, number text, invoice_date date, client_name text, is_credit_note boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support', 'office_sales', 'office') THEN
    RAISE EXCEPTION 'invoice_print_index: role % may not read it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT i.id, i.number, i.invoice_date, i.client_name, i.credit_note_of IS NOT NULL
                 FROM public.invoice i ORDER BY i.invoice_date DESC, i.number DESC LIMIT 500;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.invoice_print(p_invoice uuid) RETURNS TABLE(
  id uuid, number text, client_id uuid, client_name text, client_ice text, invoice_date date, issue_deadline date, due_date date,
  vat_rate_bp integer, total_ht_centimes bigint, total_vat_centimes bigint, total_ttc_centimes bigint, credit_note_of uuid,
  credit_note_of_number text, reason text, order_codes text[], advance_centimes bigint, lines jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support', 'office_sales', 'office') THEN
    RAISE EXCEPTION 'invoice_print: role % may not print an invoice', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT i.id, i.number, i.client_id, i.client_name, i.client_ice, i.invoice_date, i.issue_deadline, i.due_date, i.vat_rate_bp,
         i.total_ht_centimes, i.total_vat_centimes, i.total_ttc_centimes, i.credit_note_of,
         (SELECT c.number FROM public.invoice c WHERE c.id = i.credit_note_of),
         i.reason,
         array(SELECT DISTINCT o.code FROM public.invoice_line l JOIN public.delivery d ON d.id = l.delivery_id
                 JOIN public.sales_order o ON o.id = d.order_id WHERE l.invoice_id = i.id ORDER BY 1),
         (SELECT coalesce(sum(a.amount_centimes), 0)::bigint FROM public.invoice_advance a WHERE a.invoice_id = i.id),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', l.seq, 'description', l.description, 'volume_l', l.volume_l,
                   'price', l.unit_price_ht_centimes, 'total', l.line_ht_centimes, 'bl_no', d.bl_no, 'type_code', t.code,
                   'type_label', t.label) ORDER BY l.seq), '[]'::jsonb)
            FROM public.invoice_line l JOIN public.delivery d ON d.id = l.delivery_id
            JOIN public.sales_order o ON o.id = d.order_id JOIN public.concrete_type t ON t.id = o.concrete_type_id
           WHERE l.invoice_id = i.id)
    FROM public.invoice i WHERE i.id = p_invoice;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['invoice_print_index()', 'invoice_print(uuid)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
END $$;
