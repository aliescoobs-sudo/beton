-- T2 (Excel import for the go-live): one audit entry per imported file, with the file's hash and the counts, never its contents.
-- A rollback of a run is recorded with the existing 'reverse' action. The list is the previous one plus 'import'.
ALTER TABLE public.audit_event DROP CONSTRAINT audit_event_action_check;
--> statement-breakpoint
ALTER TABLE public.audit_event ADD CONSTRAINT audit_event_action_check CHECK (action IN (
  'insert', 'update', 'reverse', 'archive',
  'login', 'login_failed', 'logout', 'account_locked', 'permission_denied', 'export',
  'user_created', 'user_creation_failed', 'user_disabled', 'user_enabled',
  'two_factor_reset', 'two_factor_enrolled', 'recovery_codes_generated', 'recovery_code_used', 'step_up',
  'session_revoked', 'ai_proposal', 'ai_confirmation', 'telegram_link', 'clock_advance', 'view',
  'password_reset', 'import'));
