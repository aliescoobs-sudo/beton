-- master-data T15: the pilot seed (fake data, simulation only) runs as belgobeton_system, so every row is audited as
-- actor system / request id "seed". Like component and concrete_type (0021, 0022), the other master-data tables get an
-- INSERT grant and a policy for the system role only: request roles never reach these policies (they are
-- TO belgobeton_system). The app guards (assertSeedAllowed: SIMULATION_ENABLED, not REAL_DATA, not production) stay in
-- code. The two price tables also become readable by system: their guard triggers read the previous version.
GRANT INSERT ON public.zone, public.client, public.supplier, public.recette, public.recette_line,
  public.purchase_price, public.selling_price TO belgobeton_system;
--> statement-breakpoint
GRANT SELECT ON public.purchase_price, public.selling_price TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY zone_insert_system ON public.zone FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY client_insert_system ON public.client FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system' AND status = 'active' AND ice_override_reason IS NULL);
--> statement-breakpoint
CREATE POLICY supplier_insert_system ON public.supplier FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system' AND status = 'active');
--> statement-breakpoint
CREATE POLICY recette_insert_system ON public.recette FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system' AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY recette_line_insert_system ON public.recette_line FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY purchase_price_read_system ON public.purchase_price FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY purchase_price_insert_system ON public.purchase_price FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system' AND created_by = ctx.user_id());
--> statement-breakpoint
CREATE POLICY selling_price_read_system ON public.selling_price FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY selling_price_insert_system ON public.selling_price FOR INSERT TO belgobeton_system
  WITH CHECK (ctx.role() = 'system' AND created_by = ctx.user_id());
