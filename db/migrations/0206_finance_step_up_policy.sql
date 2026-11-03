-- Finance respects a stricter central step-up duration, while retaining a ten-minute ceiling.
CREATE POLICY finance_step_up_parameter_read ON public.parameter FOR SELECT TO belgobeton_migrator
 USING (key = 'auth.step_up_minutes');
--> statement-breakpoint
CREATE FUNCTION finance.step_up_minutes() RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE value jsonb;
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 SELECT p.value INTO value FROM public.parameter p WHERE p.key='auth.step_up_minutes';
 IF jsonb_typeof(value)='number' AND value::numeric>=1 AND value::numeric=trunc(value::numeric) THEN RETURN least(10,value::integer); END IF;
 RETURN 10;
END $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION finance.step_up_minutes() TO belgobeton_app;
