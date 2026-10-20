-- master-data T3 (SPEC-master-data §2): clients, and the shared code sequence (CLT-nnn, later FRN-nn).
-- Same pattern as zone: FORCE RLS, audit trigger, UPDATE but no DELETE/TRUNCATE grant (AC-MD-06). A client is
-- archived, never deleted. Plant has no access at all (SPEC-platform-security §4).
CREATE TABLE public.code_sequence (
  key        text PRIMARY KEY CHECK (key ~ '^[A-Z]{2,5}$'),
  last_value integer NOT NULL CHECK (last_value >= 0)
);
--> statement-breakpoint
ALTER TABLE public.code_sequence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.code_sequence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.code_sequence FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.code_sequence TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY code_sequence_read ON public.code_sequence FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
CREATE POLICY code_sequence_insert ON public.code_sequence FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
CREATE POLICY code_sequence_update ON public.code_sequence FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office')) WITH CHECK (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
-- Next code of a prefix, e.g. next_code('CLT', 3) = 'CLT-001'. The row lock serializes concurrent callers and a
-- rolled-back transaction gives its number back. Wider numbers are never truncated.
CREATE FUNCTION public.next_code(p_key text, p_width integer) RETURNS text LANGUAGE sql SET search_path = '' AS $$
  INSERT INTO public.code_sequence AS s (key, last_value) VALUES (p_key, 1)
  ON CONFLICT (key) DO UPDATE SET last_value = s.last_value + 1
  RETURNING p_key || '-' || lpad(s.last_value::text, greatest(p_width, length(s.last_value::text)), '0')
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.next_code(text, integer) TO belgobeton_app;
--> statement-breakpoint
SELECT audit.attach('public.code_sequence');
--> statement-breakpoint
CREATE TABLE public.client (
  id                  uuid PRIMARY KEY,
  code                text NOT NULL UNIQUE CHECK (code ~ '^CLT-[0-9]{3,}$'),
  name                text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  kind                text NOT NULL CHECK (kind IN ('company', 'person')),
  ice                 text,
  -- Why a second client with the same ICE was accepted; only owner/partner may set it (client_guard + policy).
  ice_override_reason text CHECK (ice_override_reason = btrim(ice_override_reason)
                                  AND length(ice_override_reason) BETWEEN 3 AND 500),
  phone_enc           text,
  contact_name        text CHECK (length(contact_name) <= 120),
  default_zone_id     uuid REFERENCES public.zone (id),
  payment_terms_days  integer NOT NULL DEFAULT 60 CHECK (payment_terms_days BETWEEN 0 AND 120),
  notes               text CHECK (length(notes) <= 2000),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  CHECK (ice IS NULL OR (ice ~ '^[0-9]{15}$' AND kind = 'company')),
  CHECK (ice_override_reason IS NULL OR ice IS NOT NULL)
);
--> statement-breakpoint
-- One client per ICE, unless an owner/partner recorded a reason for the second one.
CREATE UNIQUE INDEX client_ice_unique ON public.client (ice) WHERE ice IS NOT NULL AND ice_override_reason IS NULL;
--> statement-breakpoint
CREATE INDEX client_status_idx ON public.client (status);
--> statement-breakpoint
ALTER TABLE public.client ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.client FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.client FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.client TO belgobeton_app;
--> statement-breakpoint
-- Key rotation (crypto:rotate) re-seals the phone as the system actor; it can touch nothing else.
GRANT SELECT ON public.client TO belgobeton_system;
--> statement-breakpoint
GRANT UPDATE (phone_enc) ON public.client TO belgobeton_system;
--> statement-breakpoint
CREATE POLICY client_read ON public.client FOR SELECT TO belgobeton_app, belgobeton_system
  USING (ctx.role() IN ('owner', 'partner', 'office', 'system'));
--> statement-breakpoint
CREATE POLICY client_insert ON public.client FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() IN ('owner', 'partner', 'office') AND status = 'active'
              AND (ice_override_reason IS NULL OR ctx.role() IN ('owner', 'partner')));
--> statement-breakpoint
CREATE POLICY client_update ON public.client FOR UPDATE TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office')) WITH CHECK (ctx.role() IN ('owner', 'partner', 'office'));
--> statement-breakpoint
CREATE POLICY client_update_system ON public.client FOR UPDATE TO belgobeton_system
  USING (ctx.role() = 'system') WITH CHECK (ctx.role() = 'system');
--> statement-breakpoint
-- Rules a row policy cannot express because they compare OLD and NEW: the code never changes, and only
-- owner/partner archive a client or change its ICE override.
CREATE FUNCTION public.client_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'client.code is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.ice_override_reason IS DISTINCT FROM OLD.ice_override_reason)
     AND ctx.role() NOT IN ('owner', 'partner') THEN
    RAISE EXCEPTION 'client: only owner or partner may archive or override the ICE guard'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER client_guard BEFORE UPDATE ON public.client FOR EACH ROW EXECUTE FUNCTION public.client_guard();
--> statement-breakpoint
SELECT audit.attach('public.client');
