-- C3: the office names an order by its code (it cannot read the orders): marks it as a pumped pour, or not.
CREATE FUNCTION public.set_order_pumped_by_code(p_code text, p_pumped boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public._pump_actor_check();
  SELECT o.id INTO v_id FROM public.sales_order o WHERE o.code = upper(btrim(p_code)) AND o.reverses_id IS NULL;
  IF v_id IS NULL THEN RAISE EXCEPTION 'pump: not a live order' USING ERRCODE = 'check_violation'; END IF;
  RETURN public.set_order_pumped(v_id, p_pumped);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.set_order_pumped_by_code(text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.set_order_pumped_by_code(text, boolean) TO belgobeton_app;
