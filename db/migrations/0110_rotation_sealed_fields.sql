-- D6 / F06 (CODEX-REVIEW-FINAL): four sealed fields were not in the key-rotation registry, so `crypto-rotate` reported success while they
-- stayed on retired keys: trip_instruction.address_enc, pump_job.address_enc, cancellation_case.redirect_address_enc (supplier.phone_enc
-- already had its grants). Key rotation re-seals as the system actor, which may read these tables and update ONLY the sealed column,
-- exactly like client.phone_enc (migration 0018): it gets no right on the rest of the row.
GRANT SELECT ON public.trip_instruction, public.pump_job, public.cancellation_case TO belgobeton_system;
--> statement-breakpoint
GRANT UPDATE (address_enc) ON public.trip_instruction TO belgobeton_system;
--> statement-breakpoint
GRANT UPDATE (address_enc) ON public.pump_job TO belgobeton_system;
--> statement-breakpoint
GRANT UPDATE (redirect_address_enc) ON public.cancellation_case TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY trip_instruction_system_read ON public.trip_instruction FOR SELECT TO belgobeton_app, belgobeton_system USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY trip_instruction_system_update ON public.trip_instruction FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY pump_job_system_read ON public.pump_job FOR SELECT TO belgobeton_app, belgobeton_system USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY pump_job_system_update ON public.pump_job FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY cancellation_case_system_read ON public.cancellation_case FOR SELECT TO belgobeton_app, belgobeton_system USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY cancellation_case_system_update ON public.cancellation_case FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
