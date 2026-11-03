/** Separate from pilot money rights: support, partner and office never inherit finance. */
export const FINANCE_PERMISSIONS = {
  'finance.read': ['owner', 'app_admin'],
  'finance.write': ['owner', 'app_admin'],
  'finance.export': ['owner', 'app_admin', 'accountant'],
} as const;
export type FinancePermission = keyof typeof FINANCE_PERMISSIONS;
export function canFinance(role: string, permission: FinancePermission): boolean {
  return (FINANCE_PERMISSIONS[permission] as readonly string[]).includes(role);
}
