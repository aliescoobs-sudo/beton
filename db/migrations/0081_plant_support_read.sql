-- R1: support's read of the new tables is its own policy named support_read, like every other table (the meta-test looks for it).
DROP POLICY plant_read ON public.plant;
--> statement-breakpoint
CREATE POLICY plant_read ON public.plant FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant', 'system'));
--> statement-breakpoint
CREATE POLICY support_read ON public.plant FOR SELECT TO belgobeton_app USING (ctx.role() = 'support');
--> statement-breakpoint
DROP POLICY receipt_plant_confirmation_read ON public.receipt_plant_confirmation;
--> statement-breakpoint
CREATE POLICY receipt_plant_confirmation_read ON public.receipt_plant_confirmation FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'plant'));
--> statement-breakpoint
CREATE POLICY support_read ON public.receipt_plant_confirmation FOR SELECT TO belgobeton_app USING (ctx.role() = 'support');
