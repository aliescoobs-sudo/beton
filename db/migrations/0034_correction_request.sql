-- ledger L5b (DECISIONS 81): office enters money records blind, so it cannot reverse or edit them. It files a correction
-- request instead: the code of a document (CMD-, ACH-, FA-) and a reason, never an amount. Insert-only; the owner
-- reads the queue (support too, read-only) and posts the reversal through the normal reversal pattern. Office cannot read
-- the table back, so a request tells it nothing about the document (an unknown code is accepted like a real one).
CREATE TABLE public.correction_request (
  id            uuid PRIMARY KEY,
  document_code text NOT NULL CHECK (document_code ~ '^(CMD|ACH|FA)-[0-9]{4}-[0-9]{5,}$'),
  reason        text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 500),
  requested_by  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX correction_request_code_idx ON public.correction_request (document_code);
--> statement-breakpoint
ALTER TABLE public.correction_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.correction_request FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.correction_request FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.correction_request TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY correction_request_read ON public.correction_request FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY correction_request_insert ON public.correction_request FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'office') AND requested_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.correction_request');
--> statement-breakpoint
SELECT audit.attach('public.correction_request');
