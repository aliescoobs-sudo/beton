-- operations O11 (SPEC-operations §7.1, AC-OPS-19): the tolerance of the consumption report is a parameter the plant and the
-- partner must be able to read through the operations door (they cannot read the parameter table); same for the safety days
-- of the reorder suggestion (O12). Only the whitelist grows: the function still returns the stored value and nothing else.
CREATE OR REPLACE FUNCTION public.ops_parameter(p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'partner', 'office', 'plant', 'support', 'system') THEN
    RAISE EXCEPTION 'ops_parameter: role % may not read parameters', coalesce(ctx.role(), '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key NOT IN ('concrete_limit_min', 'unloading_min', 'load_excess_tolerance_bp', 'loading_min', 'return_extra_min',
                   'working_min', 'day_start_min', 'default_one_way_min', 'consumption_tolerance_bp',
                   'reorder_margin_days') THEN
    RAISE EXCEPTION 'ops_parameter: % is not an operations parameter', p_key USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT p.value FROM public.parameter p WHERE p.key = p_key);
END $$;
