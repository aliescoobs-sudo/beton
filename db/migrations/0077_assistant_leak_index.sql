-- assistant A6 (SPEC-assistant §4; AC-ASSIST-05, 06): what must never reach a model. Before every outbound payload the application
-- scans it against every name, number and sealed phone or address we hold. The system role (the application's own server side,
-- never a person's session) cannot read most of these tables (drivers, users, instruments are not its to read, and money tables are
-- hidden from it by D81), so one reviewed SECURITY DEFINER function hands it the strings to look for and nothing else: no id, no
-- link between a string and its row, no amount, no date. It answers the system role only.
CREATE FUNCTION public.assistant_leak_index() RETURNS TABLE (kind text, value text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'assistant_leak_index: only the system role may ask' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT 'name'::text, c.name FROM public.client c
    UNION ALL SELECT 'name', c.contact_name FROM public.client c WHERE c.contact_name IS NOT NULL
    UNION ALL SELECT 'name', s.name FROM public.supplier s
    UNION ALL SELECT 'name', d.name FROM public.driver d
    UNION ALL SELECT 'name', u.name FROM public."user" u
    UNION ALL SELECT 'name', u.email FROM public."user" u
    UNION ALL SELECT 'name', t.plate FROM public.truck t WHERE t.plate IS NOT NULL
    UNION ALL SELECT 'name', k.label FROM public.client_site k WHERE k.label IS NOT NULL
    UNION ALL SELECT 'name', i.bank FROM public.payment_instrument i WHERE i.bank IS NOT NULL
    UNION ALL SELECT 'number', c.ice FROM public.client c WHERE c.ice IS NOT NULL
    UNION ALL SELECT 'number', s.ice FROM public.supplier s WHERE s.ice IS NOT NULL
    UNION ALL SELECT 'number', i.number FROM public.payment_instrument i WHERE i.number IS NOT NULL
    UNION ALL SELECT 'sealed', c.phone_enc FROM public.client c WHERE c.phone_enc IS NOT NULL
    UNION ALL SELECT 'sealed', s.phone_enc FROM public.supplier s WHERE s.phone_enc IS NOT NULL
    UNION ALL SELECT 'sealed', k.address_enc FROM public.client_site k WHERE k.address_enc IS NOT NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assistant_leak_index() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.assistant_leak_index() TO belgobeton_system;
--> statement-breakpoint
-- The definer reads as the migrator, which RLS applies to (FORCE) on these tables: it needs a read policy on each, for this function.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['driver', 'payment_instrument', 'client_site', 'supplier', 'client', 'truck'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'leak_index_definer_read') THEN
      EXECUTE format('CREATE POLICY leak_index_definer_read ON public.%I FOR SELECT TO belgobeton_migrator USING (true)', t);
    END IF;
  END LOOP;
END $$;
