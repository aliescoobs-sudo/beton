-- T22 (SPEC-clock §3): simulated clock singleton. The table is created by every migration run, but a row exists only
-- once the app has booted with SIMULATION_ENABLED=true (src/modules/clock/boot.ts); without a 'simulated' row,
-- ctx.sim_now() is NULL and nothing in the system sees a simulated time.
CREATE TABLE public.sim_clock (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode       text NOT NULL CHECK (mode IN ('real', 'simulated')),
  sim_now    timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL
);
--> statement-breakpoint
ALTER TABLE public.sim_clock ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sim_clock FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.sim_clock FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.sim_clock TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.sim_clock TO belgobeton_system;
--> statement-breakpoint
GRANT SELECT ON public.sim_clock TO belgobeton_auth;
--> statement-breakpoint
-- No DELETE grant: the singleton is never removed; leaving simulation flips mode back to 'real'.
CREATE POLICY sim_clock_read ON public.sim_clock FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'system'));
--> statement-breakpoint
-- The badge and clock.now() run before any session (login page).
CREATE POLICY sim_clock_read_auth ON public.sim_clock FOR SELECT TO belgobeton_auth USING (true);
--> statement-breakpoint
-- ctx.sim_now() below runs as the table owner, which FORCE ROW LEVEL SECURITY also binds.
CREATE POLICY sim_clock_read_definer ON public.sim_clock FOR SELECT TO belgobeton_migrator USING (true);
--> statement-breakpoint
CREATE POLICY sim_clock_insert ON public.sim_clock FOR INSERT TO belgobeton_system WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY sim_clock_update ON public.sim_clock FOR UPDATE TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'system')) WITH CHECK (ctx.role() IN ('owner', 'system'));
--> statement-breakpoint
-- AC-CLK-05: time never moves backwards, whoever writes (service check is only the friendly message).
CREATE FUNCTION public.sim_clock_forward_only() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.sim_now < OLD.sim_now THEN
    RAISE EXCEPTION 'sim_clock: sim_now cannot move backwards (% -> %)', OLD.sim_now, NEW.sim_now
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sim_clock_forward_only BEFORE UPDATE ON public.sim_clock
  FOR EACH ROW EXECUTE FUNCTION public.sim_clock_forward_only();
--> statement-breakpoint
-- Current simulated instant, or NULL in real mode. SECURITY DEFINER so every actor (including 'anonymous' failed
-- logins) gets the same sim_at stamped on its audit events; withRlsContext() copies it into app.sim_at.
CREATE FUNCTION ctx.sim_now() RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$ SELECT sim_now FROM public.sim_clock WHERE mode = 'simulated' $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ctx.sim_now() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ctx.sim_now() TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint
SELECT audit.attach('public.sim_clock');
