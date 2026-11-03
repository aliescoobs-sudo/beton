-- C2: two narrow probes for the server's start and its readiness check. Neither returns data, only a count.
-- The runtime login has no right on the drizzle schema, so the readiness check could only look for two tables (CODEX-REVIEW-R9 item 13).
CREATE FUNCTION public.applied_migrations() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::int FROM drizzle.__drizzle_migrations
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.applied_migrations() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.applied_migrations() TO belgobeton_app, belgobeton_system;
--> statement-breakpoint
-- How many business records exist: the protected first start (FIRST_BOOT) refuses to run next to real transactions.
CREATE FUNCTION public.first_boot_record_count() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (SELECT count(*) FROM public.client) + (SELECT count(*) FROM public.supplier) + (SELECT count(*) FROM public.sales_order)
       + (SELECT count(*) FROM public.delivery) + (SELECT count(*) FROM public.invoice) + (SELECT count(*) FROM public.payment_instrument)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.first_boot_record_count() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.first_boot_record_count() TO belgobeton_system;
