-- C3 (REQUIREMENTS-V1 §7 step 5): the optional photo of the signed BL, taken by the driver on the phone. It belongs to the rotation,
-- not to the office's own BL scan (`delivery_file`, which needs the signed return recorded by the office); the office compares them.
-- The bytes are sealed in the file store under the same id (type and magic bytes checked, metadata including GPS stripped,
-- src/lib/files). Written by one door, for the driver of the rotation, after the m³ unloaded is reported. Never a price.
CREATE TABLE public.driver_bl_photo (
  -- Also the name of the sealed file in the store.
  id           uuid PRIMARY KEY,
  trip_id      uuid NOT NULL REFERENCES public.trip_plan (id),
  driver_id    uuid NOT NULL REFERENCES public.driver (id),
  plant_id     uuid REFERENCES public.plant (id),
  -- Copied from the rotation when the photo is written, so that the offices can list and open it without reading the planning.
  trip_date    date NOT NULL,
  order_code   text NOT NULL,
  seq          integer NOT NULL CHECK (seq BETWEEN 1 AND 3),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The phone's time of the shot (bounded like the taps) and the phone's key: a replay of the upload changes nothing.
  taken_at     timestamptz NOT NULL,
  client_key   text NOT NULL CHECK (length(client_key) BETWEEN 8 AND 80),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, seq),
  UNIQUE (driver_id, client_key)
);
--> statement-breakpoint
ALTER TABLE public.driver_bl_photo ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.driver_bl_photo FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.driver_bl_photo FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.driver_bl_photo TO belgobeton_app;
--> statement-breakpoint
-- Who reads the photo: the offices, the owner roles and the plant (a plant manager only the photos of their plant). Not the driver
-- again (the phone does not list files back), not the accountant, not the portals.
CREATE POLICY driver_bl_photo_read ON public.driver_bl_photo FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'office') OR (ctx.role() = 'plant' AND (ctx.plant_scope() IS NULL OR plant_id = ctx.plant_scope())));
--> statement-breakpoint
CREATE POLICY driver_bl_photo_definer ON public.driver_bl_photo FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
SELECT public.grant_support_read('public.driver_bl_photo');
--> statement-breakpoint
SELECT audit.attach('public.driver_bl_photo');
--> statement-breakpoint

-- The door: the driver of the rotation, after the unloading is reported, at most three photos, idempotent on the phone's key.
-- The row is written first; the caller seals the bytes in the same request and rolls the transaction back if sealing fails.
CREATE FUNCTION public.driver_attach_bl_photo(p_trip uuid, p_file uuid, p_type text, p_size integer, p_sha text, p_at timestamptz, p_key text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_driver uuid := ctx.driver_id();
  v_plant  uuid;
  v_date   date;
  v_order  text;
  v_seq    integer;
BEGIN
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'driver_attach_bl_photo: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.plant_id, p.trip_date, o.code INTO v_plant, v_date, v_order
    FROM public.trip_plan p JOIN public.sales_order o ON o.id = p.order_id WHERE p.id = p_trip AND p.driver_id = v_driver;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver_attach_bl_photo: not your rotation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_at > now() + interval '5 minutes' OR p_at < now() - interval '48 hours' THEN
    RAISE EXCEPTION 'driver_attach_bl_photo: the time of the shot is not credible' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.driver_bl_photo f WHERE f.driver_id = v_driver AND f.client_key = p_key) THEN
    RETURN 'replayed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trip_driver_report r WHERE r.trip_id = p_trip AND r.kind = 'unloaded') THEN
    RAISE EXCEPTION 'driver_attach_bl_photo: the unloading is not reported yet' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(f.seq), 0) + 1 INTO v_seq FROM public.driver_bl_photo f WHERE f.trip_id = p_trip;
  IF v_seq > 3 THEN
    RAISE EXCEPTION 'driver_attach_bl_photo: at most three photos per rotation' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.driver_bl_photo (id, trip_id, driver_id, plant_id, trip_date, order_code, seq, content_type, size_bytes, sha256, taken_at, client_key)
  VALUES (p_file, p_trip, v_driver, v_plant, v_date, v_order, v_seq, p_type, p_size, p_sha, p_at, p_key);
  RETURN 'recorded';
END $$;
--> statement-breakpoint
-- How many photos each rotation of the driver's day has (the phone shows a tick; it never lists the files).
CREATE FUNCTION public.driver_bl_photo_counts(p_date date) RETURNS TABLE(trip_id uuid, n integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF ctx.driver_id() IS NULL THEN
    RAISE EXCEPTION 'driver_bl_photo_counts: not a driver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT f.trip_id, count(*)::integer FROM public.driver_bl_photo f JOIN public.trip_plan p ON p.id = f.trip_id
     WHERE f.driver_id = ctx.driver_id() AND p.trip_date = p_date GROUP BY f.trip_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.driver_attach_bl_photo(uuid, uuid, text, integer, text, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.driver_bl_photo_counts(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.driver_attach_bl_photo(uuid, uuid, text, integer, text, timestamptz, text) TO belgobeton_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.driver_bl_photo_counts(date) TO belgobeton_app;
