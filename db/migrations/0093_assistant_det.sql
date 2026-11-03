-- R10 (CP-PROD-PLAN, REQUIREMENTS-V1 §11; DECISIONS 149): the deterministic assistant's reports. No external model is involved: a report is
-- a database function that counts recorded facts, and a survey is a short questionnaire per role whose results go to the owner and
-- app_admin. Nothing here computes or returns an amount.

CREATE POLICY scheduled_job_run_definer_read ON public.scheduled_job_run FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint

-- 1. The anomaly report: how the application and the operations behaved in a window. Counts and codes only.
CREATE FUNCTION public.anomaly_report(p_from date, p_to date, p_now timestamptz)
  RETURNS TABLE(kind text, n integer, refs text[]) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support') THEN
    RAISE EXCEPTION 'anomaly_report: role % may not read it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from > p_to OR p_to - p_from > 92 THEN
    RAISE EXCEPTION 'anomaly_report: invalid window' USING ERRCODE = 'check_violation';
  END IF;
  -- scheduled jobs that failed (errors)
  RETURN QUERY SELECT 'job_failed'::text, count(*)::integer, coalesce((array_agg(j.job_key || ' ' || j.business_date::text ORDER BY j.business_date DESC))[1:5], '{}')
    FROM public.scheduled_job_run j WHERE j.status = 'failed' AND j.business_date BETWEEN p_from AND p_to;
  -- rotations started and not finished, silent for more than 4 hours
  RETURN QUERY SELECT 'stuck_trip'::text, count(*)::integer, coalesce((array_agg(x.code || '#' || x.seq ORDER BY x.code))[1:5], '{}')
    FROM (SELECT o.code, t.seq FROM public.trip_plan t JOIN public.sales_order o ON o.id = t.order_id
           WHERE t.trip_date BETWEEN p_from AND p_to
             AND EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM public.trip_event e WHERE e.trip_id = t.id AND e.step = 'back')
             AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation c WHERE c.trip_id = t.id)
             AND (SELECT max(e.at) FROM public.trip_event e WHERE e.trip_id = t.id) < p_now - interval '4 hours') x;
  -- cancellations after the concrete was made (cases 3 to 7)
  RETURN QUERY SELECT 'late_cancellation'::text, count(*)::integer, coalesce((array_agg(o.code ORDER BY c.opened_at DESC))[1:5], '{}')
    FROM public.cancellation_case c JOIN public.sales_order o ON o.id = c.order_id
   WHERE c.case_no BETWEEN 3 AND 7 AND c.opened_at::date BETWEEN p_from AND p_to;
  -- stock counted and corrected
  RETURN QUERY SELECT 'stock_variance'::text, count(DISTINCT m.source_id)::integer, '{}'::text[]
    FROM public.stock_movement m WHERE m.source = 'count_adjustment' AND m.movement_date BETWEEN p_from AND p_to;
  -- a receipt the plant confirmed and the office has not completed for more than 2 days
  RETURN QUERY SELECT 'late_confirmation'::text, count(*)::integer, coalesce((array_agg(p.code ORDER BY c.confirmed_at))[1:5], '{}')
    FROM public.receipt_plant_confirmation c JOIN public.purchase p ON p.id = c.purchase_id
   WHERE c.receipt_id IS NULL AND c.confirmed_at < p_now - interval '2 days';
  -- loads whose signed BL has not come back after 3 days
  RETURN QUERY SELECT 'bl_not_returned'::text, count(*)::integer, coalesce((array_agg(d.bl_no ORDER BY d.load_date))[1:5], '{}')
    FROM public.delivery d
   WHERE d.reverses_id IS NULL AND d.load_date BETWEEN p_from AND p_to AND d.load_date < p_now::date - 3
     AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_return x WHERE x.delivery_id = d.id);
END $$;
--> statement-breakpoint

-- 2. Field surveys: a short questionnaire for one role about what that role does in the app.
CREATE TABLE public.survey (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience_role text NOT NULL,
  title         text NOT NULL CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 120),
  questions     jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 10),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.survey_response (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id  uuid NOT NULL REFERENCES public.survey(id),
  respondent uuid NOT NULL,
  answers    jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object' AND length(answers::text) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (survey_id, respondent)
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['survey', 'survey_response'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''owner'')', t || '_read', t);
    EXECUTE format('CREATE POLICY support_read ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''support'')', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('SELECT audit.attach(''public.%I'')', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.create_survey(p_audience text, p_title text, p_questions jsonb) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; q jsonb;
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'create_survey: role % may not create one', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_audience NOT IN ('office_sales', 'office_purchases', 'office', 'plant_manager', 'plant', 'driver', 'pump_operator', 'accountant') THEN
    RAISE EXCEPTION 'create_survey: unknown audience' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_questions) <> 'array' THEN RAISE EXCEPTION 'create_survey: questions' USING ERRCODE = 'check_violation'; END IF;
  FOR q IN SELECT * FROM jsonb_array_elements(p_questions) LOOP
    IF coalesce(q ->> 'id', '') !~ '^[a-z0-9_]{1,20}$' OR length(coalesce(q ->> 'text', '')) NOT BETWEEN 1 AND 200
       OR coalesce(q ->> 'kind', '') NOT IN ('yes_no', 'scale', 'text') THEN
      RAISE EXCEPTION 'create_survey: invalid question' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  INSERT INTO public.survey (audience_role, title, questions, created_by) VALUES (p_audience, btrim(p_title), p_questions, ctx.user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.close_survey(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin') THEN
    RAISE EXCEPTION 'close_survey: owner or app_admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.survey SET status = 'closed' WHERE id = p_id AND status = 'open';
  RETURN FOUND;
END $$;
--> statement-breakpoint
-- What is open for the caller's own role and not yet answered by the caller.
CREATE FUNCTION public.my_surveys() RETURNS TABLE(id uuid, title text, questions jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.id, s.title, s.questions FROM public.survey s
   WHERE s.status = 'open' AND s.audience_role = ctx.actor_role()
     AND NOT EXISTS (SELECT 1 FROM public.survey_response r WHERE r.survey_id = s.id AND r.respondent = ctx.user_id())
   ORDER BY s.created_at
$$;
--> statement-breakpoint
CREATE FUNCTION public.answer_survey(p_id uuid, p_answers jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.survey%ROWTYPE; q jsonb; a jsonb;
BEGIN
  SELECT * INTO s FROM public.survey WHERE id = p_id;
  IF NOT FOUND OR s.status <> 'open' OR s.audience_role <> ctx.actor_role() THEN
    RAISE EXCEPTION 'answer_survey: not available' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_answers) <> 'object' THEN RAISE EXCEPTION 'answer_survey: invalid answers' USING ERRCODE = 'check_violation'; END IF;
  FOR q IN SELECT * FROM jsonb_array_elements(s.questions) LOOP
    a := p_answers -> (q ->> 'id');
    IF a IS NULL THEN CONTINUE; END IF;
    IF (q ->> 'kind' = 'yes_no' AND jsonb_typeof(a) <> 'boolean')
       OR (q ->> 'kind' = 'scale' AND (jsonb_typeof(a) <> 'number' OR (a #>> '{}')::numeric NOT BETWEEN 1 AND 5 OR (a #>> '{}')::numeric <> round((a #>> '{}')::numeric)))
       OR (q ->> 'kind' = 'text' AND (jsonb_typeof(a) <> 'string' OR length(a #>> '{}') > 500)) THEN
      RAISE EXCEPTION 'answer_survey: invalid answer' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  INSERT INTO public.survey_response (survey_id, respondent, answers) VALUES (p_id, ctx.user_id(), p_answers);
  RETURN true;
END $$;
--> statement-breakpoint
-- The results for the owner and app_admin: per question, the counts (yes/no, 1 to 5) or the free texts, with no name of a respondent.
CREATE FUNCTION public.survey_results(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.survey%ROWTYPE; q jsonb; out jsonb := '[]'::jsonb; n integer;
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support') THEN
    RAISE EXCEPTION 'survey_results: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO s FROM public.survey WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO n FROM public.survey_response WHERE survey_id = p_id;
  FOR q IN SELECT * FROM jsonb_array_elements(s.questions) LOOP
    out := out || jsonb_build_array(jsonb_build_object(
      'id', q ->> 'id', 'text', q ->> 'text', 'kind', q ->> 'kind',
      'answers', CASE q ->> 'kind'
        WHEN 'text' THEN coalesce((SELECT jsonb_agg(r.answers ->> (q ->> 'id') ORDER BY r.created_at) FROM public.survey_response r
                                    WHERE r.survey_id = p_id AND r.answers ? (q ->> 'id')), '[]'::jsonb)
        ELSE coalesce((SELECT jsonb_object_agg(v, c) FROM (SELECT r.answers ->> (q ->> 'id') AS v, count(*) AS c FROM public.survey_response r
                        WHERE r.survey_id = p_id AND r.answers ? (q ->> 'id') GROUP BY 1) z), '{}'::jsonb) END));
  END LOOP;
  RETURN jsonb_build_object('title', s.title, 'audience', s.audience_role, 'status', s.status, 'responses', n, 'questions', out);
END $$;
--> statement-breakpoint
CREATE FUNCTION public.surveys_list() RETURNS TABLE(id uuid, title text, audience_role text, status text, responses integer, created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support') THEN
    RAISE EXCEPTION 'surveys_list: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT s.id, s.title, s.audience_role, s.status, (SELECT count(*)::integer FROM public.survey_response r WHERE r.survey_id = s.id), s.created_at
                 FROM public.survey s ORDER BY s.created_at DESC;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['anomaly_report(date, date, timestamptz)', 'create_survey(text, text, jsonb)', 'close_survey(uuid)', 'my_surveys()',
                           'answer_survey(uuid, jsonb)', 'survey_results(uuid)', 'surveys_list()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
END $$;
