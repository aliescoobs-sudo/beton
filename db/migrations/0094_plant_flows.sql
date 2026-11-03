-- Batch B §16.5, §16.8, §16.9 (REQUIREMENTS-V1 §16; DECISIONS 150): transfers between the plants, one timeline per order, the day close per plant.
-- Quantities, times and people only: no amount is stored or returned by anything here.

-- 1. Transfers of materials and fuel between Tétouan and Chefchaouen: sent (out of the origin), in transit, received (with the quantity
-- really received), the variance kept, and who is responsible at each step. A material transfer moves stock: the origin loses the
-- quantity sent when it is sent, the destination gains the quantity received when it is received; the difference is the variance.
ALTER TABLE public.stock_movement DROP CONSTRAINT stock_movement_source_check;
--> statement-breakpoint
ALTER TABLE public.stock_movement ADD CONSTRAINT stock_movement_source_check
  CHECK (source IN ('delivery', 'receipt', 'count_adjustment', 'opening', 'reversal', 'transfer_out', 'transfer_in'));
--> statement-breakpoint
CREATE TABLE public.plant_transfer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('material', 'fuel')),
  from_plant   uuid NOT NULL REFERENCES public.plant(id),
  to_plant     uuid NOT NULL REFERENCES public.plant(id),
  component_id uuid REFERENCES public.component(id),
  -- Base units of the component for a material, litres for fuel.
  qty          bigint NOT NULL CHECK (qty > 0),
  received_qty bigint CHECK (received_qty IS NULL OR received_qty >= 0),
  status       text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'in_transit', 'received')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_plant <> to_plant),
  CHECK ((kind = 'material') = (component_id IS NOT NULL)),
  CHECK ((status = 'received') = (received_qty IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE public.plant_transfer_step (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.plant_transfer(id),
  step        text NOT NULL CHECK (step IN ('sent', 'in_transit', 'received')),
  qty         bigint NOT NULL CHECK (qty >= 0),
  actor       uuid NOT NULL,
  actor_role  text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  note        text CHECK (note IS NULL OR length(note) <= 300),
  UNIQUE (transfer_id, step)
);
--> statement-breakpoint
-- The day close: one row per plant and day, written by close_day only.
CREATE TABLE public.day_close (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id   uuid NOT NULL REFERENCES public.plant(id),
  close_date date NOT NULL,
  forced     boolean NOT NULL DEFAULT false,
  note       text CHECK (note IS NULL OR length(note) <= 300),
  closed_by  uuid NOT NULL,
  closed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plant_id, close_date),
  CHECK (NOT forced OR note IS NOT NULL)
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plant_transfer', 'plant_transfer_step', 'day_close'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT ON public.%I TO belgobeton_app', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() IN (''owner'', ''partner'', ''plant''))', t || '_read', t);
    EXECUTE format('CREATE POLICY support_read ON public.%I FOR SELECT TO belgobeton_app USING (ctx.role() = ''support'')', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true)', t || '_definer', t);
    EXECUTE format('SELECT audit.attach(''public.%I'')', t);
  END LOOP;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.transfer_actor_ok(p_plant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ctx.actor_role() IN ('owner', 'app_admin') OR (ctx.actor_role() = 'plant_manager' AND p_plant = ctx.plant_scope())
$$;
--> statement-breakpoint
CREATE FUNCTION public.transfer_send(p_kind text, p_from uuid, p_to uuid, p_component uuid, p_qty bigint, p_date date, p_note text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF NOT public.transfer_actor_ok(p_from) THEN
    RAISE EXCEPTION 'transfer: only the sending plant manager, the owner or app_admin sends' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'transfer: quantity' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.plant WHERE id = p_from AND status = 'active')
     OR NOT EXISTS (SELECT 1 FROM public.plant WHERE id = p_to AND status = 'active') THEN
    RAISE EXCEPTION 'transfer: both plants must be active' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.plant_transfer (id, kind, from_plant, to_plant, component_id, qty)
    VALUES (v_id, p_kind, p_from, p_to, CASE WHEN p_kind = 'material' THEN p_component END, p_qty);
  INSERT INTO public.plant_transfer_step (transfer_id, step, qty, actor, actor_role, note)
    VALUES (v_id, 'sent', p_qty, ctx.user_id(), ctx.actor_role(), nullif(btrim(coalesce(p_note, '')), ''));
  IF p_kind = 'material' THEN
    INSERT INTO public.stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by, plant_id)
      VALUES (gen_random_uuid(), p_component, p_date, -p_qty, 'transfer_out', v_id, ctx.user_id(), p_from);
  END IF;
  PERFORM public.notify('transfer', 'info', jsonb_build_object('step', 'sent', 'kind', p_kind), '/transfers', p_to,
                        ARRAY['plant_manager', 'owner', 'app_admin'], NULL);
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.transfer_pickup(p_id uuid, p_note text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.plant_transfer%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.plant_transfer WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR t.status <> 'sent' THEN RETURN false; END IF;
  IF NOT public.transfer_actor_ok(t.from_plant) THEN
    RAISE EXCEPTION 'transfer: only the sending plant manager, the owner or app_admin hands it to the carrier' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.plant_transfer SET status = 'in_transit' WHERE id = p_id;
  INSERT INTO public.plant_transfer_step (transfer_id, step, qty, actor, actor_role, note)
    VALUES (p_id, 'in_transit', t.qty, ctx.user_id(), ctx.actor_role(), nullif(btrim(coalesce(p_note, '')), ''));
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.transfer_receive(p_id uuid, p_qty bigint, p_date date, p_note text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.plant_transfer%ROWTYPE; v_var bigint;
BEGIN
  SELECT * INTO t FROM public.plant_transfer WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR t.status <> 'in_transit' THEN RAISE EXCEPTION 'transfer: not in transit' USING ERRCODE = 'check_violation'; END IF;
  IF NOT public.transfer_actor_ok(t.to_plant) THEN
    RAISE EXCEPTION 'transfer: only the receiving plant manager, the owner or app_admin receives' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_qty IS NULL OR p_qty < 0 OR p_qty > t.qty * 11 / 10 THEN
    RAISE EXCEPTION 'transfer: received quantity out of range' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.plant_transfer SET status = 'received', received_qty = p_qty WHERE id = p_id;
  INSERT INTO public.plant_transfer_step (transfer_id, step, qty, actor, actor_role, note)
    VALUES (p_id, 'received', p_qty, ctx.user_id(), ctx.actor_role(), nullif(btrim(coalesce(p_note, '')), ''));
  IF t.kind = 'material' AND p_qty > 0 THEN
    INSERT INTO public.stock_movement (id, component_id, movement_date, qty_base, source, source_id, created_by, plant_id)
      VALUES (gen_random_uuid(), t.component_id, p_date, p_qty, 'transfer_in', p_id, ctx.user_id(), t.to_plant);
  END IF;
  v_var := t.qty - p_qty;
  IF v_var <> 0 THEN
    PERFORM public.notify('transfer', 'important', jsonb_build_object('step', 'variance', 'kind', t.kind), '/transfers', t.from_plant,
                          ARRAY['owner', 'app_admin'], NULL);
  END IF;
  RETURN v_var;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.transfers_list() RETURNS TABLE(id uuid, kind text, from_plant uuid, to_plant uuid, component_id uuid, qty bigint, received_qty bigint,
  status text, variance bigint, sent_by_role text, received_by_role text, created_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support', 'partner', 'plant', 'plant_manager') THEN
    RAISE EXCEPTION 'transfers: role % may not read them', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT t.id, t.kind, t.from_plant, t.to_plant, t.component_id, t.qty, t.received_qty, t.status, t.qty - t.received_qty,
      (SELECT s.actor_role FROM public.plant_transfer_step s WHERE s.transfer_id = t.id AND s.step = 'sent'),
      (SELECT s.actor_role FROM public.plant_transfer_step s WHERE s.transfer_id = t.id AND s.step = 'received'), t.created_at
    FROM public.plant_transfer t
   WHERE ctx.actor_role() <> 'plant_manager' OR t.from_plant = ctx.plant_scope() OR t.to_plant = ctx.plant_scope()
   ORDER BY t.created_at DESC LIMIT 200;
END $$;
--> statement-breakpoint

-- 2. One timeline per order: recorded, planned (and every re-plan), mixed, left, arrived, unloading, unloaded, returned, BL, invoiced, collected.
-- Each entry carries who did it, the device time (the tap) and the server time (when it reached the server), so an offline tap stays
-- traceable. Invoiced and collected say a document exists or a payment arrived, never how much; only the roles that read money see them.
CREATE FUNCTION public.order_timeline(p_order uuid)
  RETURNS TABLE(step text, at timestamptz, synced_at timestamptz, actor_name text, ref text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_plant uuid; v_money boolean := ctx.actor_role() IN ('owner', 'app_admin', 'support', 'accountant');
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() IN ('driver', 'pump_operator', 'client_portal', 'supplier_portal') THEN
    RAISE EXCEPTION 'order_timeline: role % may not read it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT o.plant_id INTO v_plant FROM public.sales_order o WHERE o.id = p_order AND o.reverses_id IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  IF ctx.actor_role() = 'plant_manager' AND v_plant IS DISTINCT FROM ctx.plant_scope() THEN RETURN; END IF;
  RETURN QUERY
    WITH events AS (
      SELECT 'recorded'::text AS s, o.created_at AS a, o.created_at AS y, o.created_by AS who, o.code AS r
        FROM public.sales_order o WHERE o.id = p_order
      UNION ALL
      SELECT CASE WHEN b.n = 1 THEN 'planned' ELSE 'replanned' END, b.created_at, b.created_at, b.created_by, 'batch ' || b.n::text
        FROM (SELECT t.batch_id, min(t.created_at) AS created_at, (array_agg(t.created_by))[1] AS created_by,
                     row_number() OVER (ORDER BY min(t.created_at)) AS n
                FROM public.trip_plan t WHERE t.order_id = p_order GROUP BY t.batch_id) b
      UNION ALL
      SELECT CASE e.step WHEN 'loaded' THEN 'mixed' WHEN 'departed' THEN 'left' WHEN 'arrived' THEN 'arrived'
                         WHEN 'unloading_started' THEN 'unloading' WHEN 'unloading_finished' THEN 'unloaded' ELSE 'returned' END,
             e.at, e.created_at, e.created_by, 'T' || t.seq::text
        FROM public.trip_event e JOIN public.trip_plan t ON t.id = e.trip_id WHERE t.order_id = p_order
      UNION ALL
      SELECT 'bl', d.loaded_at, d.created_at, d.created_by, d.bl_no
        FROM public.delivery d WHERE d.order_id = p_order AND d.reverses_id IS NULL
      UNION ALL
      SELECT 'invoiced', i.created_at, i.created_at, i.created_by, i.number
        FROM public.invoice i WHERE v_money AND i.order_id = p_order
      UNION ALL
      SELECT 'collected', a.created_at, a.created_at, a.created_by, NULL
        FROM public.allocation a JOIN public.payment_plan_item p ON p.id = a.payment_plan_item_id
       WHERE v_money AND p.order_id = p_order AND a.reverses_id IS NULL)
    SELECT ev.s, ev.a, ev.y, u.name, ev.r FROM events ev LEFT JOIN public."user" u ON u.id = ev.who::text ORDER BY ev.a, ev.y;
END $$;
--> statement-breakpoint

-- 3. The day close per plant: what is still open on the day (loads nobody confirmed, loads whose signed BL has not come back, stock
-- counted and corrected). Blocking items stop the close and go to the owner, who can close it knowingly with a note.
CREATE FUNCTION public.day_close_status(p_plant uuid, p_date date)
  RETURNS TABLE(kind text, n integer, refs text[], blocking boolean) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support', 'partner', 'plant', 'plant_manager') THEN
    RAISE EXCEPTION 'day_close: role % may not read it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ctx.actor_role() = 'plant_manager' AND p_plant IS DISTINCT FROM ctx.plant_scope() THEN
    RAISE EXCEPTION 'day_close: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT 'unconfirmed_load'::text, count(*)::integer, coalesce((array_agg(d.bl_no ORDER BY d.bl_no))[1:5], '{}'), true
    FROM public.delivery d
   WHERE d.plant_id = p_plant AND d.load_date = p_date AND d.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_delivered x WHERE x.delivery_id = d.id);
  RETURN QUERY SELECT 'missing_bl'::text, count(*)::integer, coalesce((array_agg(d.bl_no ORDER BY d.bl_no))[1:5], '{}'), false
    FROM public.delivery d
   WHERE d.plant_id = p_plant AND d.load_date = p_date AND d.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.delivery r WHERE r.reverses_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM public.delivery_return x WHERE x.delivery_id = d.id);
  RETURN QUERY SELECT 'stock_variance'::text, count(DISTINCT m.source_id)::integer, '{}'::text[], true
    FROM public.stock_movement m WHERE m.plant_id = p_plant AND m.movement_date = p_date AND m.source = 'count_adjustment';
END $$;
--> statement-breakpoint
-- 'closed', 'blocked' (the owner and app_admin are told) or 'already'.
CREATE FUNCTION public.close_day(p_plant uuid, p_date date, p_force boolean, p_note text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_block integer; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'plant_manager') THEN
    RAISE EXCEPTION 'day_close: role % may not close a day', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ctx.actor_role() = 'plant_manager' AND p_plant IS DISTINCT FROM ctx.plant_scope() THEN
    RAISE EXCEPTION 'day_close: another plant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.day_close WHERE plant_id = p_plant AND close_date = p_date) THEN RETURN 'already'; END IF;
  SELECT coalesce(sum(s.n), 0) INTO v_block FROM public.day_close_status(p_plant, p_date) s WHERE s.blocking;
  IF v_block > 0 THEN
    IF NOT (p_force AND ctx.actor_role() IN ('owner', 'app_admin') AND v_note IS NOT NULL) THEN
      PERFORM public.notify('day_close_blocking', 'important', jsonb_build_object('items', v_block), '/day-close', p_plant,
                            ARRAY['owner', 'app_admin'], NULL);
      RETURN 'blocked';
    END IF;
  END IF;
  INSERT INTO public.day_close (plant_id, close_date, forced, note, closed_by) VALUES (p_plant, p_date, v_block > 0, v_note, ctx.user_id());
  RETURN 'closed';
END $$;
--> statement-breakpoint
CREATE FUNCTION public.day_closes_list(p_from date, p_to date) RETURNS TABLE(plant_id uuid, close_date date, forced boolean, note text, closed_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.actor_role() IS NULL OR ctx.actor_role() NOT IN ('owner', 'app_admin', 'support', 'partner', 'plant', 'plant_manager') THEN
    RAISE EXCEPTION 'day_close: role % may not read it', coalesce(ctx.actor_role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT c.plant_id, c.close_date, c.forced, c.note, c.closed_at FROM public.day_close c
   WHERE c.close_date BETWEEN p_from AND p_to AND (ctx.actor_role() <> 'plant_manager' OR c.plant_id = ctx.plant_scope())
   ORDER BY c.close_date DESC, c.plant_id;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['transfer_send(text, uuid, uuid, uuid, bigint, date, text)', 'transfer_pickup(uuid, text)', 'transfer_receive(uuid, bigint, date, text)',
                           'transfers_list()', 'order_timeline(uuid)', 'day_close_status(uuid, date)', 'close_day(uuid, date, boolean, text)',
                           'day_closes_list(date, date)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO belgobeton_app', f);
  END LOOP;
  REVOKE EXECUTE ON FUNCTION public.transfer_actor_ok(uuid) FROM PUBLIC;
END $$;
