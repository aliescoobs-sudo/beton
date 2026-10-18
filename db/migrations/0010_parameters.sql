-- T19: configurable parameters. Owner writes; owner/partner/system jobs read; the auth role reads (login lockout runs
-- before any session). Every change is captured by the audit trigger with before/after.
CREATE TABLE public.parameter (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z0-9_.]+$'),
  value      jsonb NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL
);
--> statement-breakpoint
ALTER TABLE public.parameter ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.parameter FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.parameter FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.parameter TO belgobeton_app;
--> statement-breakpoint
GRANT SELECT ON public.parameter TO belgobeton_auth;
--> statement-breakpoint
CREATE POLICY parameter_read ON public.parameter FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'system'));
--> statement-breakpoint
CREATE POLICY parameter_read_auth ON public.parameter FOR SELECT TO belgobeton_auth USING (true);
--> statement-breakpoint
CREATE POLICY parameter_insert ON public.parameter FOR INSERT TO belgobeton_app WITH CHECK (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY parameter_update ON public.parameter FOR UPDATE TO belgobeton_app
  USING (ctx.role() = 'owner') WITH CHECK (ctx.role() = 'owner');
--> statement-breakpoint
-- Row id for tables keyed by `key` instead of `id`.
CREATE OR REPLACE FUNCTION audit.capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM audit.append(
    lower(TG_OP),
    TG_TABLE_NAME,
    coalesce(to_jsonb(NEW) ->> 'id', to_jsonb(NEW) ->> 'key'),
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
    to_jsonb(NEW),
    NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
SELECT audit.attach('public.parameter');
