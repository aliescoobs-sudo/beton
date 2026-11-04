-- T1 (training instance): a database that has been seeded with the training data carries a marker, and a server that boots on it
-- without TRAINING_MODE=true refuses to start (so the fictitious data and the password-only training accounts can never be mistaken
-- for a production database, nor a production database be left open by the training flag). One row at most. Written only by
-- `seed:training` through the maintenance login; the runtime logins can only ask whether it exists.
CREATE TABLE public.training_marker (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  seeded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.training_marker ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.training_marker FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.training_marker FROM PUBLIC;
--> statement-breakpoint
-- Selectable by the runtime logins but with no policy for them: row-level security shows them nothing.
GRANT SELECT ON public.training_marker TO belgobeton_app, belgobeton_system, belgobeton_auth;
--> statement-breakpoint
CREATE POLICY training_marker_maintenance ON public.training_marker FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION public.training_seeded() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.training_marker)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.training_seeded() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.training_seeded() TO belgobeton_app, belgobeton_system, belgobeton_auth;
