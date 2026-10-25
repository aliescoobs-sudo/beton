-- Review of CP-OPS-1-3, point 5: one source for the low-stock threshold, stock_threshold (versioned, audited, owner and partner
-- write). The value the component carried is copied into it where the component has none yet, then the column goes: nothing
-- reads or writes it any more. The copy is attributed to the system actor; the audit log keeps the history of the old column.
CREATE POLICY stock_threshold_migration ON public.stock_threshold FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Data steps in a migration write as the system actor: the audit trigger needs a request context.
SELECT set_config('app.user_id', '00000000-0000-7000-8000-000000000002', true),
       set_config('app.role', 'system', true),
       set_config('app.request_id', 'migration-0055', true);
--> statement-breakpoint
INSERT INTO public.stock_threshold (id, component_id, low_qty_base, created_by)
SELECT gen_random_uuid(), c.id, c.low_stock_threshold, '00000000-0000-7000-8000-000000000002'::uuid
  FROM public.component c
 WHERE c.low_stock_threshold > 0
   AND NOT EXISTS (SELECT 1 FROM public.stock_threshold t WHERE t.component_id = c.id);
--> statement-breakpoint
DROP POLICY stock_threshold_migration ON public.stock_threshold;
--> statement-breakpoint
ALTER TABLE public.component DROP COLUMN low_stock_threshold;
