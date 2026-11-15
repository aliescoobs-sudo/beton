-- T19 item 4: set_client_terms (a SECURITY DEFINER door run as the migrator) updates exactly two columns of client (po_required, price_basis). The migrator had a read policy only, so the update
-- saw no row under FORCE RLS. This policy is TO belgobeton_migrator ONLY: no request role gains anything. No data.
CREATE POLICY client_definer_update ON public.client FOR UPDATE TO belgobeton_migrator USING (true) WITH CHECK (true);
