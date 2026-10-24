-- ledger L6 (AC-LED-12): a price different from the one in force on a single order. Only the owner may enter it, with a
-- mandatory reason that is stored on the order and audited. Office keeps the plain insert (no reason, so the guard forces the
-- price in force); a price that differs from the one in force without a reason is refused by the guard trigger (0033).
DROP POLICY sales_order_insert ON public.sales_order;
--> statement-breakpoint
CREATE POLICY sales_order_insert ON public.sales_order FOR INSERT TO belgobeton_app
  WITH CHECK (
    created_by = ctx.user_id() AND (
      (ctx.role() = 'office' AND reverses_id IS NULL AND reason IS NULL)
      OR (ctx.role() = 'owner' AND reverses_id IS NULL)
      OR (ctx.role() = 'owner' AND reverses_id IS NOT NULL AND reason IS NOT NULL)
    )
  );
