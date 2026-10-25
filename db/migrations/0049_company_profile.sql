-- ledger L29 (DECISIONS 82): our own legal identity, printed on delivery notes, invoices and credit notes (ICE, IF, RC,
-- taxe professionnelle, address, RIB). Versioned and insert-only: a change is a new row, the profile in force on a date
-- is the latest `effective_from` that has started. Read by every signed-in role (delivery notes are printed by all), written
-- by the owner. No money; the pilot seed fills it with fake values.
CREATE TABLE public.company_profile (
  id             uuid PRIMARY KEY,
  effective_from date NOT NULL,
  legal_name     text NOT NULL CHECK (legal_name = btrim(legal_name) AND length(legal_name) BETWEEN 1 AND 200),
  legal_form     text NOT NULL CHECK (legal_form = btrim(legal_form) AND length(legal_form) BETWEEN 1 AND 60),
  ice            text NOT NULL CHECK (ice ~ '^[0-9]{15}$'),
  if_number      text NOT NULL CHECK (if_number = btrim(if_number) AND length(if_number) BETWEEN 1 AND 30),
  rc_number      text NOT NULL CHECK (rc_number = btrim(rc_number) AND length(rc_number) BETWEEN 1 AND 40),
  -- Taxe professionnelle (patente).
  patente        text NOT NULL CHECK (patente = btrim(patente) AND length(patente) BETWEEN 1 AND 40),
  address        text NOT NULL CHECK (address = btrim(address) AND length(address) BETWEEN 1 AND 300),
  phone          text CHECK (phone = btrim(phone) AND length(phone) BETWEEN 1 AND 40),
  email          text CHECK (email = btrim(email) AND length(email) BETWEEN 3 AND 200),
  rib            text CHECK (rib ~ '^[0-9]{24}$'),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX company_profile_effective_idx ON public.company_profile (effective_from, created_at);
--> statement-breakpoint
ALTER TABLE public.company_profile ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.company_profile FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.company_profile FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.company_profile TO belgobeton_app;
--> statement-breakpoint
CREATE POLICY company_profile_read ON public.company_profile FOR SELECT TO belgobeton_app
  USING (ctx.role() IN ('owner', 'partner', 'office', 'plant'));
--> statement-breakpoint
CREATE POLICY company_profile_insert ON public.company_profile FOR INSERT TO belgobeton_app
  WITH CHECK (ctx.role() = 'owner' AND created_by = ctx.user_id());
--> statement-breakpoint
SELECT public.grant_support_read('public.company_profile');
--> statement-breakpoint
SELECT audit.attach('public.company_profile');
