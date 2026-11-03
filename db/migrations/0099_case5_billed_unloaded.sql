-- C3 (REQUIREMENTS-V1 §8 case 5, §4 "billed if actually unloaded"): when the unloading stopped midway, the invoice bills the m³ the
-- driver unloaded, not the m³ loaded. One function names the billed volume of a load; the invoice door, the invoice line guard and
-- the invoice queue all read it. The order total and its payment plan keep the ordered quantity (as they already do for loads above
-- the volume); the surplus is the case's redirect or loss, never billed. A load with no case 5 is billed at its own volume as before.
CREATE FUNCTION public.delivery_billed_l(p_delivery uuid, p_volume_l integer) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT c.unloaded_volume_l FROM public.cancellation_case c
                    WHERE c.delivery_id = p_delivery AND c.case_no = 5 AND c.unloaded_volume_l > 0
                      AND c.unloaded_volume_l < p_volume_l
                    ORDER BY c.opened_at DESC LIMIT 1), p_volume_l)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.delivery_billed_l(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.delivery_billed_l(uuid, integer) TO belgobeton_migrator;
--> statement-breakpoint
DO $$
DECLARE v text;
BEGIN
  -- the invoice door
  v := pg_get_functiondef('public.create_invoice_from_deliveries__inner(uuid[],date,date)'::regprocedure);
  IF position('SELECT d.id, d.volume_l, d.bl_no' IN v) = 0 OR position('public.order_price(o.id), d.volume_l, 1000)' IN v) = 0 THEN
    RAISE EXCEPTION 'create_invoice_from_deliveries__inner changed shape';
  END IF;
  v := replace(v, 'SELECT d.id, d.volume_l, d.bl_no', 'SELECT d.id, public.delivery_billed_l(d.id, d.volume_l) AS volume_l, d.bl_no');
  v := replace(v, 'public.order_price(o.id), d.volume_l, 1000)', 'public.order_price(o.id), public.delivery_billed_l(d.id, d.volume_l), 1000)');
  EXECUTE v;
  -- the line guard
  v := pg_get_functiondef('public.invoice_line_guard()'::regprocedure);
  IF position('IF NEW.volume_l <> v_d.volume_l THEN' IN v) = 0 THEN RAISE EXCEPTION 'invoice_line_guard changed shape'; END IF;
  EXECUTE replace(v, 'IF NEW.volume_l <> v_d.volume_l THEN', 'IF NEW.volume_l <> public.delivery_billed_l(v_d.id, v_d.volume_l) THEN');
  -- the queue the offices read: what will be billed
  v := pg_get_functiondef('public.invoice_queue()'::regprocedure);
  IF position('d.volume_l, c.id, c.code' IN v) = 0 THEN RAISE EXCEPTION 'invoice_queue changed shape'; END IF;
  EXECUTE replace(v, 'd.volume_l, c.id, c.code', 'public.delivery_billed_l(d.id, d.volume_l), c.id, c.code');
END $$;
--> statement-breakpoint
-- A partly unloaded load keeps its BL: only a redirect or a loss of the WHOLE load (cases 3, 4, 6, 7) marks the BL "annulé".
DO $$
DECLARE v text;
BEGIN
  v := pg_get_functiondef('public.delivery_note(uuid)'::regprocedure);
  IF position('c.delivery_id = d.id AND c.decision IN (''redirect'', ''loss'')' IN v) = 0 THEN RAISE EXCEPTION 'delivery_note changed shape'; END IF;
  EXECUTE replace(v, 'c.delivery_id = d.id AND c.decision IN (''redirect'', ''loss'')', 'c.delivery_id = d.id AND c.case_no <> 5 AND c.decision IN (''redirect'', ''loss'')');
END $$;
