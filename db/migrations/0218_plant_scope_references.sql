-- R18-01: a plant manager's scope must apply to the PARENT and CHILD references a privileged function reads, not only to the row he reaches.
--   1. plant_fill / trip_plan_guard (privileged, BEFORE the INSERT policy) read the order, truck and driver of a new plan or load BEFORE the policy could refuse it,
--      so a manager could attach his plan to a live order with NO plant (it then showed in trip_timing, order code included) and the error text told a foreign
--      order, a missing order and an unusable truck or driver apart. For a scoped actor the references are now checked FIRST, once, in plant_fill (the first
--      BEFORE trigger): the order must exist and be his plant's, the truck must exist and be his plant's or plantless (hired / pump), the driver must be one he may know of.
--      Absent, foreign and plantless references get ONE answer, which names no reference.
--   2. dispatch_office, order_timeline and trip_timing return only rows whose plan, order, truck, load and driver are ALL in the scope (a historical mismatch is not shown).
-- Forward migration.
CREATE OR REPLACE FUNCTION public.plant_fill() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_parent uuid;      -- the plant of the parent document, when there is one
  v_truck  uuid;
  v_n      integer;
  v_only   uuid;
  v_found  boolean := true;
  v_tfound boolean := true;
  v_driver text;
BEGIN
  IF TG_TABLE_NAME IN ('delivery', 'trip_plan') THEN
    SELECT o.plant_id, true INTO v_parent, v_found FROM public.sales_order o WHERE o.id = NEW.order_id;
    v_found := coalesce(v_found, false);
    SELECT t.plant_id, true INTO v_truck, v_tfound FROM public.truck t WHERE t.id = NEW.truck_id;
    v_tfound := coalesce(v_tfound, false);
    -- R18-01: a scoped actor reaches only references of his own plant; absent, foreign and plantless are ONE answer, before any other diagnostic
    IF ctx.plant_scope() IS NOT NULL THEN
      IF v_found IS NOT TRUE OR v_parent IS DISTINCT FROM ctx.plant_scope()
         OR v_tfound IS NOT TRUE OR (v_truck IS NOT NULL AND v_truck <> ctx.plant_scope()) THEN
        RAISE EXCEPTION '%: reference not available', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- only a plan has a driver (a load has no such field: it must not even be named in an expression evaluated for a load)
      IF TG_TABLE_NAME = 'trip_plan' THEN
        v_driver := to_jsonb(NEW) ->> 'driver_id';
        IF v_driver IS NOT NULL AND public.driver_in_plant_scope(v_driver::uuid) IS NOT TRUE THEN
          RAISE EXCEPTION '%: reference not available', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'purchase_receipt' THEN
    SELECT p.plant_id INTO v_parent FROM public.purchase p WHERE p.id = NEW.purchase_id;
  ELSIF TG_TABLE_NAME = 'stock_movement' THEN
    IF NEW.source = 'delivery' THEN
      SELECT d.plant_id INTO v_parent FROM public.delivery d WHERE d.id = NEW.source_id;
    ELSIF NEW.source = 'receipt' THEN
      SELECT r.plant_id INTO v_parent FROM public.purchase_receipt r WHERE r.id = NEW.source_id;
    ELSIF NEW.source = 'reversal' THEN
      SELECT m.plant_id INTO v_parent FROM public.stock_movement m WHERE m.id = NEW.reverses_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'fuel_fill' THEN
    SELECT t.plant_id INTO v_parent FROM public.truck t WHERE t.id = NEW.truck_id;
  END IF;

  IF NEW.plant_id IS NOT NULL AND v_parent IS NOT NULL AND NEW.plant_id <> v_parent THEN
    RAISE EXCEPTION '%: the plant is not the plant of its document', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.plant_id IS NULL THEN NEW.plant_id := v_parent; END IF;
  IF NEW.plant_id IS NULL THEN NEW.plant_id := ctx.plant_id(); END IF;

  IF NEW.plant_id IS NULL THEN
    SELECT count(*), (array_agg(p.id))[1] INTO v_n, v_only FROM public.plant p WHERE p.status = 'active';
    IF v_n = 1 THEN
      NEW.plant_id := v_only;
    ELSIF v_n >= 2 THEN
      RAISE EXCEPTION '%: the plant is required', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.plant_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.plant p WHERE p.id = NEW.plant_id AND p.status = 'active') THEN
      RAISE EXCEPTION '%: the plant is archived or unknown', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A mixer belongs to one plant; it does not load or get planned at the other. Pumps and external trucks have none.
  IF v_truck IS NOT NULL AND NEW.plant_id IS NOT NULL AND v_truck <> NEW.plant_id THEN
    RAISE EXCEPTION '%: the truck belongs to another plant', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- trip_timing: for a plant manager the plan, its order, its truck and its driver are all his (a mismatched historical row is not returned, and
-- the order code of a plantless order never leaves).
CREATE OR REPLACE FUNCTION public.trip_timing(p_date date)
 RETURNS TABLE(trip_id uuid, seq integer, order_code text, plant_id uuid, truck_id uuid, truck_code text, driver_id uuid, driver_name text, zone_id uuid, zone_name text, one_way_min integer, load_min integer, depart_min integer, arrive_min integer, unload_end_min integer, back_min integer, steps json)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_driver uuid := ctx.driver_id(); v_role text := ctx.actor_role();
BEGIN
  IF v_driver IS NULL AND v_role IS DISTINCT FROM 'plant_manager' AND v_role IS DISTINCT FROM 'owner'
     AND v_role IS DISTINCT FROM 'app_admin' THEN
    RAISE EXCEPTION 'trip_timing: role % may not read the timing of rotations', coalesce(v_role, '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT p.id, p.seq, o.code, p.plant_id, p.truck_id, k.code, p.driver_id, d.name, o.zone_id, z.name, z.one_way_min,
         p.load_min, p.depart_min, p.arrive_min, p.unload_end_min, p.back_min,
         coalesce((SELECT json_agg(json_build_object('step', s.step, 'at', s.at) ORDER BY s.at) FROM (
            -- the time of a tap for the figures and alerts: a correction's, else the plant's confirmation (it is the authority for departed / back), else the phone's own time (an offline tap), else the server's
            SELECT e.step, coalesce((SELECT c.corrected_at FROM public.trip_event_correction c WHERE c.trip_id = e.trip_id AND c.step = e.step
                                      ORDER BY c.created_at DESC, c.id DESC LIMIT 1),
                                    (SELECT f.confirmed_at FROM public.trip_event_confirmation f WHERE f.trip_id = e.trip_id AND f.step = e.step),
                                    e.client_time, e.at) AS at
              FROM public.trip_event e WHERE e.trip_id = p.id AND e.step <> 'loading_started'
            UNION ALL SELECT r.kind, r.at FROM public.trip_driver_report r WHERE r.trip_id = p.id AND r.kind = 'loading_started') s), '[]'::json)
    FROM public.trip_plan p
    JOIN public.sales_order o ON o.id = p.order_id
    JOIN public.truck k ON k.id = p.truck_id
    LEFT JOIN public.driver d ON d.id = p.driver_id
    LEFT JOIN public.zone z ON z.id = o.zone_id
   WHERE p.trip_date = p_date
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
     AND ((v_driver IS NOT NULL AND p.driver_id = v_driver)
          OR v_role IN ('owner', 'app_admin')
          OR (v_role = 'plant_manager' AND ctx.plant_scope() IS NOT NULL AND p.plant_id = ctx.plant_scope() AND o.plant_id = ctx.plant_scope()
              AND (k.plant_id IS NULL OR k.plant_id = ctx.plant_scope())
              AND (p.driver_id IS NULL OR public.driver_in_plant_scope(p.driver_id))))
   ORDER BY p.truck_id, p.load_min, p.seq;
END $$;
--> statement-breakpoint

-- dispatch_office: a plant manager sees a plan only when the plan, its order and its truck are his, and the BL of a load only when the load is his too.
CREATE OR REPLACE FUNCTION public.dispatch_office(p_date date)
 RETURNS TABLE(trip_id uuid, trip_date date, seq integer, truck_code text, truck_plate text, client_name text, site_label text, zone_name text, volume_l integer, load_min integer, depart_min integer, arrive_min integer, unload_end_min integer, back_min integer, step text, bl_no text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.role() IS NULL OR coalesce(ctx.role(), '') NOT IN ('office', 'owner', 'partner', 'plant', 'support') THEN
    RAISE EXCEPTION 'dispatch_office: role % may not read the dispatch', coalesce(ctx.role(), '(none)') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT p.id, p.trip_date, p.seq, t.code, t.plate, c.name, s.label, z.name, p.volume_l, p.load_min, p.depart_min, p.arrive_min,
         p.unload_end_min, p.back_min,
         (SELECT e.step FROM public.trip_event e WHERE e.trip_id = p.id ORDER BY e.at DESC, e.created_at DESC LIMIT 1),
         (SELECT d.bl_no FROM public.trip_event e JOIN public.delivery d ON d.id = e.delivery_id WHERE e.trip_id = p.id AND e.step = 'loaded'
             AND (ctx.actor_role() IS DISTINCT FROM 'plant_manager' OR d.plant_id = ctx.plant_scope()))
    FROM public.trip_plan p
    JOIN public.truck t ON t.id = p.truck_id
    JOIN public.sales_order o ON o.id = p.order_id
    JOIN public.client c ON c.id = o.client_id
    LEFT JOIN public.client_site s ON s.id = o.site_id
    LEFT JOIN public.zone z ON z.id = o.zone_id
   WHERE p.trip_date = p_date
     AND (ctx.actor_role() IS DISTINCT FROM 'plant_manager'
          OR (ctx.plant_scope() IS NOT NULL AND o.plant_id = ctx.plant_scope() AND p.plant_id = ctx.plant_scope()
              AND (t.plant_id IS NULL OR t.plant_id = ctx.plant_scope())))
     AND NOT EXISTS (SELECT 1 FROM public.trip_plan_cancellation x WHERE x.trip_id = p.id)
   ORDER BY p.load_min, t.code, p.seq
   LIMIT 300;
END $$;
--> statement-breakpoint

-- order_timeline: the children (plan batches, stage events, loads) of a plant manager's order are shown only when they are of his plant too.
CREATE OR REPLACE FUNCTION public.order_timeline(p_order uuid)
 RETURNS TABLE(step text, at timestamp with time zone, synced_at timestamp with time zone, actor_name text, ref text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_plant uuid; v_money boolean := ctx.actor_role() IN ('owner', 'app_admin', 'accountant');
        v_global text[] := ARRAY['owner', 'app_admin', 'accountant', 'office', 'office_sales', 'office_purchases', 'plant'];
BEGIN
  IF ctx.actor_role() IS NULL OR coalesce(ctx.actor_role(), '') NOT IN ('owner', 'app_admin', 'accountant', 'office', 'office_sales', 'office_purchases', 'plant', 'plant_manager') THEN
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
                FROM public.trip_plan t WHERE t.order_id = p_order AND ctx.in_actor_scope(v_global, t.plant_id) GROUP BY t.batch_id) b
      UNION ALL
      SELECT CASE e.step WHEN 'loaded' THEN 'mixed' WHEN 'departed' THEN 'left' WHEN 'arrived' THEN 'arrived'
                         WHEN 'unloading_started' THEN 'unloading' WHEN 'unloading_finished' THEN 'unloaded' ELSE 'returned' END,
             e.at, e.created_at, e.created_by, 'T' || t.seq::text
        FROM public.trip_event e JOIN public.trip_plan t ON t.id = e.trip_id
       WHERE t.order_id = p_order AND ctx.in_actor_scope(v_global, t.plant_id)
      UNION ALL
      SELECT 'bl', d.loaded_at, d.created_at, d.created_by, d.bl_no
        FROM public.delivery d WHERE d.order_id = p_order AND d.reverses_id IS NULL AND ctx.in_actor_scope(v_global, d.plant_id)
      UNION ALL
      SELECT 'invoiced', i.created_at, i.created_at, i.created_by, i.number
        FROM public.invoice i WHERE v_money AND i.order_id = p_order
      UNION ALL
      SELECT 'collected', a.created_at, a.created_at, a.created_by, NULL
        FROM public.allocation a JOIN public.payment_plan_item p ON p.id = a.payment_plan_item_id
       WHERE v_money AND p.order_id = p_order AND a.reverses_id IS NULL)
    SELECT ev.s, ev.a, ev.y, u.name, ev.r FROM events ev LEFT JOIN public."user" u ON u.id = ev.who::text ORDER BY ev.a, ev.y;
END $$;
