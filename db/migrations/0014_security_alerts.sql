-- DECISIONS 75: security alerts raised by ops tools (owner 2FA break-glass), shown to the owner and the partner until
-- each of them acknowledges. The notifications module will also deliver them once it exists.
CREATE TABLE public.security_alert (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind   text NOT NULL CHECK (kind IN ('owner_2fa_reset')),
  at     timestamptz NOT NULL,
  detail text CHECK (length(detail) <= 500)
);
--> statement-breakpoint
CREATE TABLE public.security_alert_ack (
  alert_id bigint NOT NULL REFERENCES public.security_alert (id),
  user_id  uuid NOT NULL,
  at       timestamptz NOT NULL,
  PRIMARY KEY (alert_id, user_id)
);
--> statement-breakpoint
ALTER TABLE public.security_alert ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.security_alert FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.security_alert_ack ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.security_alert_ack FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.security_alert, public.security_alert_ack FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.security_alert TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.security_alert TO belgobeton_system;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.security_alert_ack TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY security_alert_read ON public.security_alert FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'system'));
--> statement-breakpoint
CREATE POLICY security_alert_insert ON public.security_alert FOR INSERT TO belgobeton_system WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
-- Each person sees and writes only their own acknowledgements.
CREATE POLICY security_alert_ack_read ON public.security_alert_ack FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner') AND user_id = ctx.user_id());
--> statement-breakpoint
CREATE POLICY security_alert_ack_insert ON public.security_alert_ack FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner') AND user_id = ctx.user_id());
--> statement-breakpoint
SELECT audit.attach('public.security_alert');
--> statement-breakpoint
SELECT audit.attach('public.security_alert_ack');
