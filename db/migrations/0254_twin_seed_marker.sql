-- T20 (D251): the fictitious twin seed leaves ONE row when it has finished. Structure only (decision 79): the seed writes the row, never this file.
-- Same shape as training_marker (0111): written through the maintenance login only; the runtime logins can ask whether it exists, nothing more.
-- The twin seed uses it to be idempotent (a second run changes nothing) and the reset procedure removes it with the rest of the training volume.
CREATE TABLE public.twin_seed_marker (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  anchor    date NOT NULL,
  prng_seed integer NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.twin_seed_marker ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.twin_seed_marker FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.twin_seed_marker FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY twin_seed_marker_maintenance ON public.twin_seed_marker FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
