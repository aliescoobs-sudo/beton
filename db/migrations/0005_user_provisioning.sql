-- Retry-safe user creation (DECISIONS 74): a user is created disabled and marked provisioned only once its
-- credentials are written. provisionedAt IS NULL = unfinished creation, which a retry resumes.
ALTER TABLE "user" ADD COLUMN "provisionedAt" timestamptz;
--> statement-breakpoint
UPDATE "user" u SET "provisionedAt" = u."createdAt"
  WHERE EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u.id AND a."providerId" = 'credential');
--> statement-breakpoint
-- An unfinished user can never be active.
ALTER TABLE "user" ADD CONSTRAINT user_active_needs_provisioning CHECK ("status" <> 'active' OR "provisionedAt" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE public.audit_event DROP CONSTRAINT audit_event_action_check;
--> statement-breakpoint
ALTER TABLE public.audit_event ADD CONSTRAINT audit_event_action_check CHECK (action IN (
  'insert', 'update', 'reverse', 'archive',
  'login', 'login_failed', 'logout', 'account_locked', 'permission_denied', 'export',
  'user_created', 'user_creation_failed', 'two_factor_enrolled', 'recovery_codes_generated', 'recovery_code_used',
  'step_up', 'session_revoked', 'ai_proposal', 'ai_confirmation', 'telegram_link', 'clock_advance'));
