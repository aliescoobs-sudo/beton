export { ANONYMOUS_ACTOR_ID, BOOTSTRAP_ACTOR_ID } from './auth/actors';
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
export { STEP_UP_REQUIRED, type StepUpResult, withStepUp } from './auth/step-up-guard';
