-- integration I2.2 (SPEC-integration AC-INT-14): the three-way match and the payable. A supplier invoice is compared with its
-- order and its receipts, line by line: quantity (invoiced against received, and against ordered over every live invoice of the
-- line) and price (invoiced against ordered), each against a tolerance read from the parameter table (`match_qty_tolerance_bp`,
-- `match_price_tolerance_bp`; the defaults below are those of the parameter registry, a test keeps them equal). A line the order
-- does not have is a gap too. Gaps block "approve for payment" until the owner accepts them, with a reason (audited). The payable
-- (the payment plan items) is created by the approval, from the invoice: an order made the new way (payable_source = 'invoice')
-- carries no plan of its own. Orders made before keep theirs (payable_source = 'order'). Owner only, step-up in the action.

-- 1. Where the payable of an order comes from, and which invoice a plan item belongs to.
ALTER TABLE public.purchase ADD COLUMN payable_source text NOT NULL DEFAULT 'order' CHECK (payable_source IN ('order', 'invoice'));
--> statement-breakpoint
ALTER TABLE public.purchase_plan_item ADD COLUMN supplier_invoice_id uuid REFERENCES public.supplier_invoice (id);
--> statement-breakpoint
CREATE INDEX purchase_plan_item_si_idx ON public.purchase_plan_item (supplier_invoice_id) WHERE supplier_invoice_id IS NOT NULL;
--> statement-breakpoint

-- 2. The balance of a purchase: lines add up to the total HT; the plan adds up to the total TTC for an order that carries its own
--    plan; an order whose payable comes from its invoices carries none (each approved invoice has its own, checked below).
CREATE OR REPLACE FUNCTION public.purchase_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id    uuid;
  v_p     public.purchase%ROWTYPE;
  v_lines bigint;
  v_plan  bigint;
BEGIN
  IF TG_TABLE_NAME = 'purchase' THEN
    v_id := NEW.id;
  ELSE
    v_id := NEW.purchase_id;
  END IF;
  SELECT * INTO v_p FROM public.purchase p WHERE p.id = v_id;
  IF v_p.payable_source = 'invoice' THEN
    IF EXISTS (SELECT 1 FROM public.purchase_plan_item i WHERE i.purchase_id = v_id AND i.supplier_invoice_id IS NULL) THEN
      RAISE EXCEPTION 'purchase %: the payable of this order comes from its invoices, not from a plan of its own', v_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT coalesce(sum(i.amount_centimes), 0) INTO v_plan FROM public.purchase_plan_item i WHERE i.purchase_id = v_id;
    IF v_plan <> v_p.total_ttc_centimes THEN
      RAISE EXCEPTION 'payment plan of purchase % adds up to %, the purchase total is %', v_id, v_plan, v_p.total_ttc_centimes
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_p.reverses_id IS NULL THEN
    SELECT coalesce(sum(l.line_ht_centimes), 0) INTO v_lines FROM public.purchase_line l WHERE l.purchase_id = v_id;
    IF v_lines <> v_p.total_ht_centimes THEN
      RAISE EXCEPTION 'lines of purchase % add up to %, the purchase total HT is %', v_id, v_lines, v_p.total_ht_centimes
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- The plan items of one invoice add up to its total TTC (at commit, whichever arrives last).
CREATE FUNCTION public.supplier_invoice_plan_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ttc  bigint;
  v_plan bigint;
BEGIN
  SELECT s.total_ttc_centimes INTO v_ttc FROM public.supplier_invoice s WHERE s.id = NEW.supplier_invoice_id;
  SELECT coalesce(sum(i.amount_centimes), 0) INTO v_plan FROM public.purchase_plan_item i WHERE i.supplier_invoice_id = NEW.supplier_invoice_id;
  IF v_plan <> v_ttc THEN
    RAISE EXCEPTION 'the payable of supplier invoice % adds up to %, the invoice total is %', NEW.supplier_invoice_id, v_plan, v_ttc
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER supplier_invoice_plan_balanced AFTER INSERT ON public.purchase_plan_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.supplier_invoice_id IS NOT NULL)
  EXECUTE FUNCTION public.supplier_invoice_plan_balanced();
--> statement-breakpoint

-- 3. An order cannot be cancelled while a supplier invoice not rejected still stands on it: reject (or never approve) it first.
CREATE OR REPLACE FUNCTION public.purchase_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_orig   public.purchase%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.purchase p WHERE p.id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase: unknown purchase to reverse' USING ERRCODE = 'check_violation';
    END IF;
    IF v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'purchase: a reversal cannot be reversed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.supplier_id <> v_orig.supplier_id OR NEW.order_date <> v_orig.order_date OR NEW.due_date <> v_orig.due_date
       OR NEW.supplier_invoice_no IS DISTINCT FROM v_orig.supplier_invoice_no
       OR NEW.supplier_invoice_date IS DISTINCT FROM v_orig.supplier_invoice_date
       OR NEW.payable_source <> v_orig.payable_source
       OR NEW.vat_rate_bp <> v_orig.vat_rate_bp
       OR NEW.total_ht_centimes <> -v_orig.total_ht_centimes OR NEW.total_vat_centimes <> -v_orig.total_vat_centimes
       OR NEW.total_ttc_centimes <> -v_orig.total_ttc_centimes THEN
      RAISE EXCEPTION 'purchase: a reversal negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.supplier_invoice s
       WHERE s.purchase_id = v_orig.id
         AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = s.id AND e.event = 'rejected')
    ) THEN
      RAISE EXCEPTION 'purchase: a supplier invoice still stands on this order' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT s.status INTO v_status FROM public.supplier s WHERE s.id = NEW.supplier_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'purchase: the supplier is not active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 4. The plan item guard: an item of an invoice belongs to the order of that invoice, once, and not to a rejected invoice.
CREATE OR REPLACE FUNCTION public.purchase_plan_item_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_orig public.purchase_plan_item%ROWTYPE;
BEGIN
  IF NEW.supplier_invoice_id IS NOT NULL THEN
    IF NEW.reverses_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM public.supplier_invoice s
          WHERE s.id = NEW.supplier_invoice_id AND s.purchase_id = NEW.purchase_id
            AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = s.id AND e.event IN ('rejected', 'approved'))) THEN
      RAISE EXCEPTION 'purchase_plan_item: not the payable of a pending invoice of this order' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.purchase_plan_item i WHERE i.id = NEW.reverses_id;
    IF NOT FOUND OR v_orig.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'purchase_plan_item: a reversal item reverses an original item' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.purchase p WHERE p.id = NEW.purchase_id AND p.reverses_id = v_orig.purchase_id
    ) THEN
      RAISE EXCEPTION 'purchase_plan_item: a reversal item belongs to the reversal of its original purchase'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_centimes <> -v_orig.amount_centimes OR NEW.method <> v_orig.method OR NEW.due_date <> v_orig.due_date THEN
      RAISE EXCEPTION 'purchase_plan_item: a reversal item negates its original exactly' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 5. The match, line by line. Internal (the application role cannot execute it). The tolerances are the parameters in force, else
--    the registry's defaults (100 and 50 basis points).
CREATE FUNCTION public._supplier_invoice_match(p_si uuid)
RETURNS TABLE (seq integer, purchase_line_id uuid, description text, ordered_milli bigint, po_price bigint, received_milli bigint,
               invoiced_milli bigint, cumulative_milli bigint, inv_price bigint, flags text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH tol AS (
    SELECT coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'match_qty_tolerance_bp'), 100) AS qt,
           coalesce((SELECT (p.value #>> '{}')::integer FROM public.parameter p WHERE p.key = 'match_price_tolerance_bp'), 50) AS pt
  ), si AS (
    SELECT s.id, s.purchase_id FROM public.supplier_invoice s WHERE s.id = p_si
  ), l AS (
    SELECT sl.seq, sl.purchase_line_id, sl.description, sl.qty_milli AS qty, sl.unit_price_ht_centimes AS price,
           pl.qty_milli AS ordered, pl.unit_price_ht_centimes AS po_price, pl.component_id AS po_component
      FROM public.supplier_invoice_line sl LEFT JOIN public.purchase_line pl ON pl.id = sl.purchase_line_id
     WHERE sl.supplier_invoice_id = p_si
  ), recv AS (
    SELECT prl.purchase_line_id AS pline, sum(prl.qty_milli)::bigint AS q
      FROM public.purchase_receipt_line prl
      JOIN public.supplier_invoice_receipt sr ON sr.purchase_receipt_id = prl.receipt_id
     WHERE sr.supplier_invoice_id = p_si GROUP BY prl.purchase_line_id
  ), cum AS (
    SELECT sl2.purchase_line_id AS pline, sum(sl2.qty_milli)::bigint AS q
      FROM public.supplier_invoice_line sl2
      JOIN public.supplier_invoice s2 ON s2.id = sl2.supplier_invoice_id
     WHERE s2.purchase_id = (SELECT si.purchase_id FROM si)
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = s2.id AND e.event = 'rejected')
     GROUP BY sl2.purchase_line_id
  )
  SELECT l.seq, l.purchase_line_id, l.description, l.ordered, l.po_price, coalesce(recv.q, 0)::bigint, l.qty, coalesce(cum.q, 0)::bigint, l.price,
         array_remove(ARRAY[
           CASE WHEN l.purchase_line_id IS NULL THEN 'NOT_ON_ORDER' END,
           CASE WHEN l.purchase_line_id IS NOT NULL AND abs(l.price - l.po_price)::numeric * 10000 > l.po_price::numeric * tol.pt THEN 'PRICE' END,
           CASE WHEN l.po_component IS NOT NULL AND l.qty::numeric * 10000 > coalesce(recv.q, 0)::numeric * (10000 + tol.qt) THEN 'QTY_OVER_RECEIVED' END,
           CASE WHEN l.purchase_line_id IS NOT NULL AND coalesce(cum.q, 0)::numeric * 10000 > l.ordered::numeric * (10000 + tol.qt) THEN 'QTY_OVER_ORDERED' END
         ], NULL)
    FROM l CROSS JOIN tol LEFT JOIN recv ON recv.pline = l.purchase_line_id LEFT JOIN cum ON cum.pline = l.purchase_line_id
   ORDER BY l.seq
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._supplier_invoice_match(uuid) FROM PUBLIC;
--> statement-breakpoint

-- The match for the owner and support (money): what each line says against the order and the receipts, and its flags.
CREATE FUNCTION public.supplier_invoice_match(p_si uuid)
RETURNS TABLE (seq integer, purchase_line_id uuid, description text, ordered_milli bigint, po_price bigint, received_milli bigint,
               invoiced_milli bigint, cumulative_milli bigint, inv_price bigint, flags text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'support', 'system') THEN
    RAISE EXCEPTION 'supplier_invoice_match: role % may not read a match', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM public._supplier_invoice_match(p_si);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.supplier_invoice_match(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.supplier_invoice_match(uuid) TO belgobeton_app;
--> statement-breakpoint

-- The approval writes the payable as the migrator (SECURITY DEFINER).
CREATE POLICY purchase_plan_item_definer_insert ON public.purchase_plan_item FOR INSERT TO belgobeton_migrator WITH CHECK (true);
--> statement-breakpoint

-- 6. The owner's decisions on a pending invoice. Each locks the invoice, reads its last event and writes the next.
CREATE FUNCTION public._supplier_invoice_state(p_si uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.event FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = p_si ORDER BY e.seq DESC LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._supplier_invoice_state(uuid) FROM PUBLIC;
--> statement-breakpoint

-- The owner accepts the gaps of an invoice, with a reason: only when there are gaps and the invoice is just entered.
CREATE FUNCTION public.accept_supplier_invoice_gaps(p_si uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'system') THEN
    RAISE EXCEPTION 'accept_supplier_invoice_gaps: role % may not accept gaps', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'accept_supplier_invoice_gaps: a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_invoice:state:' || p_si::text, 0));
  IF public._supplier_invoice_state(p_si) IS DISTINCT FROM 'entered' THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO v_n FROM public._supplier_invoice_match(p_si) m WHERE cardinality(m.flags) > 0;
  IF v_n = 0 THEN
    RETURN false;
  END IF;
  INSERT INTO public.supplier_invoice_event (id, supplier_invoice_id, seq, event, reason, created_by)
  VALUES (gen_random_uuid(), p_si, (SELECT max(e.seq) + 1 FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = p_si),
          'gaps_accepted', btrim(p_reason), ctx.user_id());
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.accept_supplier_invoice_gaps(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.accept_supplier_invoice_gaps(uuid, text) TO belgobeton_app;
--> statement-breakpoint

-- The owner rejects an invoice that is not approved yet, with a reason; its supplier number is free again.
CREATE FUNCTION public.reject_supplier_invoice(p_si uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'system') THEN
    RAISE EXCEPTION 'reject_supplier_invoice: role % may not reject an invoice', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'reject_supplier_invoice: a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_invoice:state:' || p_si::text, 0));
  IF public._supplier_invoice_state(p_si) NOT IN ('entered', 'gaps_accepted') THEN
    RETURN false;
  END IF;
  INSERT INTO public.supplier_invoice_event (id, supplier_invoice_id, seq, event, reason, created_by)
  VALUES (gen_random_uuid(), p_si, (SELECT max(e.seq) + 1 FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = p_si),
          'rejected', btrim(p_reason), ctx.user_id());
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_supplier_invoice(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.reject_supplier_invoice(uuid, text) TO belgobeton_app;
--> statement-breakpoint

-- "Approve for payment": the owner only. Refused (false) unless the invoice is pending, and has no gap or its gaps were accepted.
-- Creates the payable: the plan items of this invoice on its order, adding up to the invoice total; `p_plan` is a JSON array of
-- {method, dueDate, amountCentimes}, else one transfer on the invoice's due date. Then writes the `approved` event.
CREATE FUNCTION public.approve_supplier_invoice(p_si uuid, p_plan jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_si    public.supplier_invoice%ROWTYPE;
  v_state text;
  v_gaps  integer;
  v_item  jsonb;
  v_sum   bigint := 0;
  v_seq   integer;
  v_user  uuid := ctx.user_id();
  v_items jsonb;
BEGIN
  IF ctx.role() IS NULL OR ctx.role() NOT IN ('owner', 'system') THEN
    RAISE EXCEPTION 'approve_supplier_invoice: role % may not approve an invoice', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_invoice:state:' || p_si::text, 0));
  SELECT * INTO v_si FROM public.supplier_invoice WHERE id = p_si;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  v_state := public._supplier_invoice_state(p_si);
  IF v_state NOT IN ('entered', 'gaps_accepted') THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO v_gaps FROM public._supplier_invoice_match(p_si) m WHERE cardinality(m.flags) > 0;
  IF v_gaps > 0 AND v_state <> 'gaps_accepted' THEN
    RAISE EXCEPTION 'approve_supplier_invoice: the invoice has gaps the owner has not accepted' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase p WHERE p.id = v_si.purchase_id AND p.payable_source = 'invoice'
                                                   AND p.reverses_id IS NULL) THEN
    RAISE EXCEPTION 'approve_supplier_invoice: the order carries its own payable' USING ERRCODE = 'check_violation';
  END IF;
  v_items := coalesce(p_plan, jsonb_build_array(jsonb_build_object('method', 'transfer', 'dueDate', to_char(v_si.due_date, 'YYYY-MM-DD'),
                                                                   'amountCentimes', v_si.total_ttc_centimes)));
  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'approve_supplier_invoice: invalid plan' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(i.seq), 0) INTO v_seq FROM public.purchase_plan_item i WHERE i.purchase_id = v_si.purchase_id;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_seq := v_seq + 1;
    IF (v_item ->> 'method') NOT IN ('cash', 'cheque', 'lcn', 'transfer', 'advance', 'installment')
       OR (v_item ->> 'amountCentimes')::bigint <= 0
       OR (v_item ->> 'dueDate')::date < v_si.invoice_date OR (v_item ->> 'dueDate')::date > v_si.invoice_date + 120 THEN
      RAISE EXCEPTION 'approve_supplier_invoice: invalid plan item' USING ERRCODE = 'check_violation';
    END IF;
    v_sum := v_sum + (v_item ->> 'amountCentimes')::bigint;
    INSERT INTO public.purchase_plan_item (id, purchase_id, seq, method, due_date, amount_centimes, supplier_invoice_id, created_by)
    VALUES (gen_random_uuid(), v_si.purchase_id, v_seq, v_item ->> 'method', (v_item ->> 'dueDate')::date,
            (v_item ->> 'amountCentimes')::bigint, p_si, v_user);
  END LOOP;
  IF v_sum <> v_si.total_ttc_centimes THEN
    RAISE EXCEPTION 'approve_supplier_invoice: the plan adds up to %, the invoice total is %', v_sum, v_si.total_ttc_centimes
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.supplier_invoice_event (id, supplier_invoice_id, seq, event, created_by)
  VALUES (gen_random_uuid(), p_si, (SELECT max(e.seq) + 1 FROM public.supplier_invoice_event e WHERE e.supplier_invoice_id = p_si),
          'approved', v_user);
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.approve_supplier_invoice(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.approve_supplier_invoice(uuid, jsonb) TO belgobeton_app;
--> statement-breakpoint

-- 7. A supplier payment for one supplier invoice: the open items of that invoice, oldest first, as allocate_to_purchase does for an
--    order. Returns the number of items touched and nothing else; 0 for anything that does not fit.
CREATE FUNCTION public.allocate_to_supplier_invoice(p_instrument uuid, p_code text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role  text := ctx.role();
  v_i     public.payment_instrument%ROWTYPE;
  v_si    public.supplier_invoice%ROWTYPE;
  v_item  public.purchase_plan_item%ROWTYPE;
  v_left  bigint;
  v_open  bigint;
  v_take  bigint;
  v_n     integer := 0;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'office', 'system') THEN
    RAISE EXCEPTION 'allocate_to_supplier_invoice: role % may not allocate', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_i FROM public.payment_instrument WHERE id = p_instrument;
  IF NOT FOUND OR v_i.direction <> 'out' OR (v_role = 'office' AND v_i.created_by <> ctx.user_id()) THEN
    RETURN 0;
  END IF;
  SELECT * INTO v_si FROM public.supplier_invoice s WHERE s.code = p_code AND s.supplier_id = v_i.supplier_id
     AND public._supplier_invoice_state(s.id) = 'approved';
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('allocation:instrument:' || v_i.id::text, 0));
  SELECT v_i.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_left
    FROM public.allocation a WHERE a.instrument_id = v_i.id;
  FOR v_item IN SELECT * FROM public.purchase_plan_item i WHERE i.supplier_invoice_id = v_si.id AND i.reverses_id IS NULL ORDER BY i.due_date, i.seq LOOP
    EXIT WHEN v_left <= 0;
    PERFORM pg_advisory_xact_lock(hashtextextended('allocation:item:' || v_item.id::text, 0));
    SELECT v_item.amount_centimes - coalesce(sum(a.amount_centimes), 0) INTO v_open
      FROM public.allocation a WHERE a.purchase_plan_item_id = v_item.id;
    CONTINUE WHEN v_open <= 0;
    v_take := least(v_open, v_left);
    INSERT INTO public.allocation (id, instrument_id, purchase_plan_item_id, amount_centimes, created_by)
    VALUES (gen_random_uuid(), v_i.id, v_item.id, v_take, ctx.user_id());
    v_left := v_left - v_take;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.allocate_to_supplier_invoice(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.allocate_to_supplier_invoice(uuid, text) TO belgobeton_app;
