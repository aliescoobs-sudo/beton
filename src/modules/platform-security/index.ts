export { ANONYMOUS_ACTOR_ID, BOOTSTRAP_ACTOR_ID, SYSTEM_ACTOR_ID } from './auth/actors';
export { type Auth, createAuth } from './auth/create-auth';
export { getAuth } from './auth/instance';
export { checkPassword } from './auth/password-policy';
export { createUser, type NewUser, type UserRole } from './auth/user-service';
export { recordAuditEvent, SERVICE_AUDIT_ACTIONS, type ServiceAuditEvent } from './service/audit-service';
export {
  isSensitiveAction,
  needsStepUp,
  SENSITIVE_ACTIONS,
  type SensitiveAction,
  STEP_UP_MAX_AGE_MS,
} from './domain/step-up';
export { REENROL_REQUIRED, STEP_UP_REQUIRED, type StepUpResult, withStepUp } from './auth/step-up-guard';
export { can, type Permission, PERMISSIONS, type Role, rolesWith, USER_ROLES } from './domain/permissions';
// Field-level hiding for role-restricted entities: declare with defineVisibility() next to the entity type and pass
// every outgoing row through project(); assert absence in tests with tests/helpers/expect-no-fields.ts.
export { defineVisibility, project, projectMany, type Visibility } from './domain/projection';
export { recordMoneyExport, recordMoneyView } from './service/money-view';
export { auditDenied, authorize, type Authorization } from './auth/guards';
// Building blocks for other modules' services. Pages and actions also need ./next (Next.js-only, not loadable by CLIs).
export type { SessionUser } from './auth/session-gate';
export { ForbiddenError } from './service/user-admin';
export { inRequest, isMalformedId, isUniqueViolation, require } from './service/request';
export { parameterOrDefault } from './domain/parameters';
