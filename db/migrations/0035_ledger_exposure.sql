-- Exposure hardening (DECISIONS 81). What office, partner and plant can reach must show no price, total, plan or amount.
-- 1. The operational view is a security barrier: a leaky function in a caller's query cannot see rows the view filters out.
ALTER VIEW public.sales_order_ops SET (security_barrier = true);
--> statement-breakpoint

-- 2. The plan-balance error no longer quotes the order total or the plan sum: an office writer reads error messages,
--    and a total in a message is a total read. The order id is enough for the owner to find the order.
CREATE OR REPLACE FUNCTION public.payment_plan_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_order uuid;
  v_total bigint;
  v_sum   bigint;
BEGIN
  IF TG_TABLE_NAME = 'sales_order' THEN
    v_order := NEW.id;
  ELSE
    v_order := NEW.order_id;
  END IF;
  SELECT o.total_ttc_centimes INTO v_total FROM public.sales_order o WHERE o.id = v_order;
  SELECT coalesce(sum(i.amount_centimes), 0) INTO v_sum FROM public.payment_plan_item i WHERE i.order_id = v_order;
  IF v_total IS NULL OR v_sum <> v_total THEN
    RAISE EXCEPTION 'payment plan of order % does not add up to the order total', v_order
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
