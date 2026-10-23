-- ledger L2 (plan decision 9): yearly document counters for CMD-YYYY-nnnnn, ACH-YYYY-nnnnn and FA-YYYY-nnnnn.
-- Nobody writes the table directly: the SECURITY DEFINER function below is the only writer, and it bumps the counter
-- inside the caller's transaction, so concurrent callers are serialized on the row lock and a rolled-back transaction
-- gives its number back (gapless: AC-LED-08, counter part). Office creates documents but never reads the counters
-- (blind entry, DECISIONS 81): the table is readable by the owner and support only.
CREATE TABLE public.doc_sequence (
  prefix     text    NOT NULL CHECK (prefix ~ '^[A-Z]{2,5}$'),
  year       integer NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  last_value integer NOT NULL CHECK (last_value >= 1),
  PRIMARY KEY (prefix, year)
);
--> statement-breakpoint
ALTER TABLE public.doc_sequence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.doc_sequence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.doc_sequence FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.doc_sequence TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY doc_sequence_read ON public.doc_sequence FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
-- The function runs as the table owner, which FORCE ROW LEVEL SECURITY still subjects to policies.
CREATE POLICY doc_sequence_definer ON public.doc_sequence FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.doc_sequence');
--> statement-breakpoint
SELECT audit.attach('public.doc_sequence');
--> statement-breakpoint
-- 'CMD', 2026, 5 → 'CMD-2026-00001'. Wider numbers are never truncated. Callers: owner and office (document entry);
-- the pilot seed role (request role 'system') is granted EXECUTE by db/seed/seed-role.sql, nobody else.
CREATE FUNCTION public.next_doc_number(p_prefix text, p_year integer, p_width integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := ctx.role();
  v_n    integer;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'next_doc_number: role % may not number documents', coalesce(v_role, '(none)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.doc_sequence AS s (prefix, year, last_value) VALUES (p_prefix, p_year, 1)
  ON CONFLICT (prefix, year) DO UPDATE SET last_value = s.last_value + 1
  RETURNING s.last_value INTO v_n;
  RETURN p_prefix || '-' || p_year::text || '-' || lpad(v_n::text, greatest(p_width, length(v_n::text)), '0');
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.next_doc_number(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.next_doc_number(text, integer, integer) TO belgobeton_app;
