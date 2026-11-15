-- T19 item 3 (D246): the opening position at 30 Nov 2026. No data (decision 79): rows come from the importer through the doors. Forward migration.
--   set_doc_counter   CMD / BL / ACH / FA numbering continues from the paper or Excel last number of a year. Owner and app_admin, actor first, forward only (a number issued is never reused).
--   source            opening rows are marked source = 'opening_30_11' (payment_instrument, opening_party_balance, opening_balance). Only owner and app_admin may set it (trigger),
--                     so an office entry can never pose as an opening row; the tables stay insert-only, so a marked row is corrected by a reversing entry, never edited.
--   aging_unknown     a party's opening balance is ONE line per party; it says whether the age of the debt is known. The sheet has no per-invoice detail yet: true until it has.
ALTER TABLE public.payment_instrument ADD COLUMN source text CHECK (source IN ('opening_30_11'));
--> statement-breakpoint
ALTER TABLE public.opening_party_balance ADD COLUMN source text CHECK (source IN ('opening_30_11'));
--> statement-breakpoint
ALTER TABLE public.opening_party_balance ADD COLUMN aging_unknown boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE public.opening_balance ADD COLUMN source text CHECK (source IN ('opening_30_11'));
--> statement-breakpoint
CREATE FUNCTION public.opening_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.source IS NOT NULL AND (ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin')) THEN
    RAISE EXCEPTION '%: only the owner or app_admin may mark a row as an opening row', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER opening_source_guard BEFORE INSERT ON public.payment_instrument FOR EACH ROW EXECUTE FUNCTION public.opening_source_guard();
--> statement-breakpoint
CREATE TRIGGER opening_source_guard BEFORE INSERT ON public.opening_party_balance FOR EACH ROW EXECUTE FUNCTION public.opening_source_guard();
--> statement-breakpoint
CREATE TRIGGER opening_source_guard BEFORE INSERT ON public.opening_balance FOR EACH ROW EXECUTE FUNCTION public.opening_source_guard();
--> statement-breakpoint
CREATE FUNCTION public.set_doc_counter(p_prefix text, p_year integer, p_last integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_now  integer;
BEGIN
  v_role := ctx.require_admitted_actor('set_doc_counter');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'set_doc_counter: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_prefix IS NULL OR p_prefix <> ALL (ARRAY['CMD', 'BL', 'ACH', 'FA']) THEN
    RAISE EXCEPTION 'set_doc_counter: the prefix is CMD, BL, ACH or FA' USING ERRCODE = 'check_violation';
  END IF;
  IF p_year NOT BETWEEN 2000 AND 2999 OR p_last NOT BETWEEN 1 AND 99999999 THEN
    RAISE EXCEPTION 'set_doc_counter: invalid number' USING ERRCODE = 'check_violation';
  END IF;
  SELECT last_value INTO v_now FROM public.doc_sequence WHERE prefix = p_prefix AND year = p_year;
  IF v_now IS NOT NULL AND p_last <= v_now THEN
    RAISE EXCEPTION 'set_doc_counter: a number already issued cannot be reused' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.doc_sequence (prefix, year, last_value) VALUES (p_prefix, p_year, p_last)
  ON CONFLICT (prefix, year) DO UPDATE SET last_value = EXCLUDED.last_value;
  RETURN p_last;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.get_doc_counter(p_prefix text, p_year integer) RETURNS integer
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('get_doc_counter');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'get_doc_counter: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT last_value FROM public.doc_sequence WHERE prefix = p_prefix AND year = p_year);
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.set_doc_counter(text, integer, integer)', 'public.get_doc_counter(text, integer)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
