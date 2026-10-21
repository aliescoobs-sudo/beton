-- master-data T12 (SPEC-master-data §2, AC-MD-10): per-client price overrides. An override is a selling_price row with a
-- client_id. It is a commercial concession, so it needs a reason (CHECK) and is written by owner/partner only
-- (policy WITH CHECK, plus the service permission client_price_override.write). Office and plant are refused by SQL too.
ALTER TABLE public.selling_price ADD CONSTRAINT selling_price_override_needs_reason
  CHECK (client_id IS NULL OR reason IS NOT NULL);
--> statement-breakpoint
CREATE POLICY selling_price_override_insert ON public.selling_price FOR INSERT TO belgobeton_app
  WITH CHECK (
    ctx.role() IN ('owner', 'partner') AND client_id IS NOT NULL AND reason IS NOT NULL
    AND created_by = ctx.user_id()
  );
