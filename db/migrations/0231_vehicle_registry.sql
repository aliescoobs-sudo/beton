-- T15 G3 (SPEC-sms-channel §4; D231, D235): the vehicle registry. The registry is the existing `truck` table (D126: there is no `vehicle` table).
--   truck.kind gains `hauler` (the sand/gravel truck, code H1..H999; no plant is required, it may serve the stock of several); truck.gps_unit_id is an optional,
--   unique, explicit mapping (a GPS unit that is not mapped is never auto-assigned).
--   sms_sender: which phone number belongs to which driver (and, optionally, the vehicle it drives). The number is SEALED (phone_enc, the FIELD_ENCRYPTION_KEYS pattern,
--   re-sealed by crypto:rotate) and looked up by a KEYED HASH (phone_hash, HMAC-SHA256 hex computed by the server with a server secret; the clear number is never stored
--   or indexed). Written ONLY by the doors below (owner and app_admin), each with a typed reason; end-dated, never deleted; one open mapping per number; at most two numbers
--   (own and spare) per driver. Read: owner and app_admin only. Nothing here receives, parses or writes a message: no webhook, no ingestion, no service actor.
-- Forward migration.
ALTER TABLE public.truck DROP CONSTRAINT truck_kind_check;
--> statement-breakpoint
ALTER TABLE public.truck ADD CONSTRAINT truck_kind_check CHECK (kind IN ('mixer', 'pump', 'external', 'hauler'));
--> statement-breakpoint
ALTER TABLE public.truck DROP CONSTRAINT truck_code_check;
--> statement-breakpoint
ALTER TABLE public.truck ADD CONSTRAINT truck_code_check CHECK (code ~ '^[TPXH][0-9]{1,3}$');
--> statement-breakpoint
ALTER TABLE public.truck DROP CONSTRAINT truck_code_kind;
--> statement-breakpoint
ALTER TABLE public.truck ADD CONSTRAINT truck_code_kind CHECK (
  (kind = 'mixer' AND code ~ '^T') OR (kind = 'pump' AND code ~ '^P') OR (kind = 'external' AND code ~ '^X') OR (kind = 'hauler' AND code ~ '^H'));
--> statement-breakpoint
ALTER TABLE public.truck ADD COLUMN gps_unit_id text CHECK (gps_unit_id = btrim(gps_unit_id) AND length(gps_unit_id) BETWEEN 1 AND 40);
--> statement-breakpoint
CREATE UNIQUE INDEX truck_gps_unit_key ON public.truck (gps_unit_id) WHERE gps_unit_id IS NOT NULL;
--> statement-breakpoint
GRANT UPDATE (gps_unit_id) ON public.truck TO belgobeton_app;
--> statement-breakpoint

CREATE TABLE public.sms_sender (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash  text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  phone_enc   text NOT NULL CHECK (phone_enc ~ '^f1\.'),
  driver_id   uuid NOT NULL REFERENCES public.driver (id),
  truck_id    uuid REFERENCES public.truck (id),
  valid_from  date NOT NULL,
  valid_to    date,
  reason_code text NOT NULL CHECK (reason_code IN ('new_driver', 'new_number', 'spare_number', 'sim_change', 'correction')),
  note        text CHECK (note = btrim(note) AND length(note) BETWEEN 1 AND 300),
  end_reason_code text CHECK (end_reason_code IN ('left_company', 'number_changed', 'lost_phone', 'correction')),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK ((valid_to IS NULL) = (end_reason_code IS NULL))
);
--> statement-breakpoint
-- exactly one open mapping per number
CREATE UNIQUE INDEX sms_sender_open_number ON public.sms_sender (phone_hash) WHERE valid_to IS NULL;
--> statement-breakpoint
CREATE INDEX sms_sender_driver_idx ON public.sms_sender (driver_id) WHERE valid_to IS NULL;
--> statement-breakpoint
ALTER TABLE public.sms_sender ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sms_sender FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.sms_sender FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.sms_sender TO belgobeton_app, belgobeton_system;
--> statement-breakpoint
-- crypto:rotate re-seals the number as the system actor and can touch nothing else
GRANT UPDATE (phone_enc) ON public.sms_sender TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY sms_sender_definer ON public.sms_sender FOR ALL TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY sms_sender_read ON public.sms_sender FOR SELECT TO belgobeton_app USING (ctx.role() = 'owner');
--> statement-breakpoint
CREATE POLICY sms_sender_read_system ON public.sms_sender FOR SELECT TO belgobeton_system USING (ctx.role() = 'system');
--> statement-breakpoint
CREATE POLICY sms_sender_update_system ON public.sms_sender FOR UPDATE TO belgobeton_system USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
-- Immutable but for two things: the end of a mapping (valid_to and its reason, once) and the re-sealing of the number by key rotation. Never deleted.
CREATE FUNCTION public.sms_sender_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sms_sender rows are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.phone_hash, NEW.driver_id, NEW.truck_id, NEW.valid_from, NEW.reason_code, NEW.note, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.phone_hash, OLD.driver_id, OLD.truck_id, OLD.valid_from, OLD.reason_code, OLD.note, OLD.created_by, OLD.created_at)
     OR (OLD.valid_to IS NOT NULL AND (NEW.valid_to, NEW.end_reason_code) IS DISTINCT FROM (OLD.valid_to, OLD.end_reason_code)) THEN
    RAISE EXCEPTION 'sms_sender: only the end of a mapping and the re-sealing of the number may change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sms_sender_guard BEFORE UPDATE OR DELETE ON public.sms_sender FOR EACH ROW EXECUTE FUNCTION public.sms_sender_guard();
--> statement-breakpoint
SELECT audit.attach('public.sms_sender');
--> statement-breakpoint

-- Registers a number for a driver. The server computes the hash and the seal; the door checks their shape and the whole tuple (driver, vehicle, owner roles only).
CREATE FUNCTION public.register_sms_sender(p_phone_hash text, p_phone_enc text, p_driver uuid, p_truck uuid, p_valid_from date, p_reason_code text, p_note text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_id   uuid := gen_random_uuid();
BEGIN
  v_role := ctx.require_admitted_actor('register_sms_sender');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'register_sms_sender: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver d WHERE d.id = p_driver AND d.status = 'active')
     OR (p_truck IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.truck t WHERE t.id = p_truck AND t.status = 'active')) THEN
    RAISE EXCEPTION 'register_sms_sender: unknown driver or vehicle' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sms_sender:' || p_driver::text, 0));
  IF (SELECT count(*) FROM public.sms_sender s WHERE s.driver_id = p_driver AND s.valid_to IS NULL) >= 2 THEN
    RAISE EXCEPTION 'register_sms_sender: a driver has at most two numbers (own and spare)' USING ERRCODE = 'check_violation';
  END IF;
  -- a number already open for another (or the same) driver is refused by the unique index (23505); never auto-registered
  INSERT INTO public.sms_sender (id, phone_hash, phone_enc, driver_id, truck_id, valid_from, reason_code, note, created_by)
  VALUES (v_id, p_phone_hash, p_phone_enc, p_driver, p_truck, p_valid_from, p_reason_code, nullif(btrim(p_note), ''), ctx.user_id());
  RETURN v_id;
END $$;
--> statement-breakpoint

-- Ends a mapping (the number changed, the driver left...). Nothing is deleted; the row keeps its history.
CREATE FUNCTION public.end_sms_sender(p_id uuid, p_valid_to date, p_end_reason_code text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_s    public.sms_sender%ROWTYPE;
BEGIN
  v_role := ctx.require_admitted_actor('end_sms_sender');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'end_sms_sender: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_s FROM public.sms_sender s WHERE s.id = p_id FOR UPDATE;
  IF NOT FOUND OR v_s.valid_to IS NOT NULL OR p_valid_to IS NULL OR p_valid_to < v_s.valid_from THEN
    RAISE EXCEPTION 'end_sms_sender: no open mapping' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.sms_sender SET valid_to = p_valid_to, end_reason_code = p_end_reason_code WHERE id = p_id;
END $$;
--> statement-breakpoint

-- The numbers and what they map to, for the owner roles; the clear number never leaves the server (the sealed value is opened there and masked).
CREATE FUNCTION public.sms_senders_list()
  RETURNS TABLE(o_id uuid, o_phone_enc text, o_driver_id uuid, o_driver_name text, o_truck_id uuid, o_truck_code text, o_valid_from date, o_valid_to date, o_reason_code text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
BEGIN
  v_role := ctx.require_admitted_actor('sms_senders_list');
  IF v_role <> ALL (ARRAY['owner', 'app_admin']) THEN
    RAISE EXCEPTION 'sms_senders_list: not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT s.id, s.phone_enc, s.driver_id, d.name, s.truck_id, t.code, s.valid_from, s.valid_to, s.reason_code
    FROM public.sms_sender s JOIN public.driver d ON d.id = s.driver_id LEFT JOIN public.truck t ON t.id = s.truck_id
   ORDER BY s.valid_to IS NOT NULL, d.name, s.created_at;
END $$;
--> statement-breakpoint
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.register_sms_sender(text, text, uuid, uuid, date, text, text)', 'public.end_sms_sender(uuid, date, text)', 'public.sms_senders_list()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO belgobeton_app', f);
  END LOOP;
END $$;
