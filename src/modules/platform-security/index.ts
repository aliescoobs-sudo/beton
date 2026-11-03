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
export {
  can,
  type Permission,
  PERMISSIONS,
  POLICY_ROLES,
  policyRoleOf,
  type PolicyRole,
  type Role,
  rolesWith,
  USER_ROLES,
} from './domain/permissions';
// Field-level hiding for role-restricted entities: declare with defineVisibility() next to the entity type and pass
// every outgoing row through project(); assert absence in tests with tests/helpers/expect-no-fields.ts.
export { defineVisibility, project, projectMany, type Visibility } from './domain/projection';
export {
  NOTIFICATION_CATALOGUE,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationSeverity,
} from './domain/notification-catalogue';
export {
  dropSubscription,
  listMyNotifications,
  markRead,
  setMyLocale,
  type NotificationView,
  saveSubscription,
  sendTestNotification,
  unreadCount,
} from './service/notification-service';
export { flushPush, vapidFromEnv, vapidJwt, type VapidKeys } from './service/web-push';
export { DOCUMENT_KINDS, type DocumentKind, isDocumentKind } from './domain/document-kinds';
export { recordMoneyExport, recordMoneyView } from './service/money-view';
export { auditDenied, authorize, type Authorization } from './auth/guards';
// Building blocks for other modules' services. Pages and actions also need ./next (Next.js-only, not loadable by CLIs).
export type { SessionUser } from './auth/session-gate';
export { ForbiddenError } from './service/user-admin';
export {
  asAiConfirmation,
  asDryRun,
  inPlant,
  inRequest,
  inRequestRolledBack,
  isMalformedId,
  isUniqueViolation,
  require,
} from './service/request';
export { parameterOrDefault, type ParameterValues } from './domain/parameters';
export { readParameters } from './service/parameter-service';

export { baseLocale, isUserLocale, USER_LOCALES, type UserLocale } from './domain/locale';
