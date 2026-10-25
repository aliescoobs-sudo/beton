-- operations O14 (SPEC-operations §7.2, AC-OPS-23): concrete that came back or was refused, recorded per load with a reason.
-- One row per load, insert-only. It does not give components back (the concrete was made), and it does not change what the
-- order bills (a credit is the owner's credit note). Quantities only: plant, office, owner and partner record and read it.
CREATE TABLE public.delivery_loss (
  id          uuid PRIMARY KEY,
  delivery_id uuid NOT NULL UNIQUE REFERENCES public.delivery (id),
  -- Litres lost, at most the load.
  volume_l    integer NOT NULL CHECK (volume_l > 0),
  reason      text NOT NULL CHECK (reason IN ('rejected_by_client', 'returned_unused', 'too_old', 'quality', 'other')),
  note        text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 300)),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.delivery_loss ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.delivery_loss FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.delivery_loss FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.delivery_loss TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY delivery_loss_read ON public.delivery_loss FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant'));
--> statement-breakpoint
CREATE POLICY delivery_loss_insert ON public.delivery_loss FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'office', 'plant') AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.delivery_loss');
--> statement-breakpoint
SELECT audit.attach('public.delivery_loss');
--> statement-breakpoint

-- The guard: a live load (not a cancellation, not cancelled), and no more than the load.
CREATE FUNCTION public.delivery_loss_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_d public.delivery%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM public.delivery WHERE id = NEW.delivery_id;
  IF NOT FOUND OR v_d.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.delivery c WHERE c.reverses_id = v_d.id) THEN
    RAISE EXCEPTION 'delivery_loss: not a live load' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.volume_l > v_d.volume_l THEN
    RAISE EXCEPTION 'delivery_loss: more than the load' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER delivery_loss_guard BEFORE INSERT ON public.delivery_loss
  FOR EACH ROW EXECUTE FUNCTION public.delivery_loss_guard();
--> statement-breakpoint
CREATE POLICY delivery_loss_definer_read ON public.delivery_loss FOR SELECT TO belgobeton_migrator USING (true);
