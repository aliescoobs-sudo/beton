/**
 * The RBAC matrix of SPEC-platform-security §4, as data. Route guards, service guards and the RLS test matrix all
 * read this one table. Default deny: a permission not listed here is granted to nobody.
 * Field-level restrictions inside a permission (e.g. plant sees orders without prices) live in field-visibility.ts.
 */
export const USER_ROLES = ['owner', 'partner', 'office', 'plant'] as const;
export type Role = (typeof USER_ROLES)[number];

const ALL = ['owner', 'partner', 'office', 'plant'] as const;
const MANAGERS = ['owner', 'partner'] as const;
const OFFICE = ['owner', 'partner', 'office'] as const;
const PLANT = ['owner', 'partner', 'plant'] as const;

export const PERMISSIONS = {
  // Users, roles, 2FA reset
  'users.manage': ['owner'],
  // Parameters
  'parameters.read': MANAGERS,
  'parameters.write': ['owner'],
  // Clients / suppliers
  'parties.read': OFFICE,
  'parties.write': OFFICE,
  // Archiving replaces deleting; a second client on an existing ICE needs a recorded reason
  'parties.archive': MANAGERS,
  'parties.ice_override': MANAGERS,
  // Components and their purchase units (no price on either: plant reads names for the recette)
  'components.read': ALL,
  'components.write': MANAGERS,
  // Concrete types, recettes (office: no cost; plant: quantities only)
  'recettes.read': ALL,
  'recettes.write': MANAGERS,
  // Purchase prices, component costs (office: on the purchases they enter)
  'purchase_prices.read': OFFICE,
  'purchase_prices.write': MANAGERS,
  // Selling prices, per-client overrides (✅ A27)
  'selling_prices.read': OFFICE,
  'selling_prices.write': MANAGERS,
  'client_price_override.write': MANAGERS,
  // Trucks, zones
  'trucks.read': ALL,
  'trucks.write': MANAGERS,
  'trucks.status.write': PLANT,
  'zones.read': ALL,
  'zones.write': MANAGERS,
  // Orders + payment plan (plant: operational fields only)
  'orders.read': ALL,
  'orders.write': OFFICE,
  'orders.price_override': MANAGERS,
  // Payment instruments, money account entries
  'instruments.read': OFFICE,
  'instruments.write': OFFICE,
  // Invoices
  'invoices.read': OFFICE,
  'invoices.write': OFFICE,
  // Purchases, supplier payments (plant: receipt lines)
  'purchases.read': ALL,
  'purchases.write': OFFICE,
  // Reversing entries; older than the reversal window: managers only
  'ledger.reverse': OFFICE,
  'ledger.reverse_old': MANAGERS,
  // Deliveries / BL (✅ A11)
  'deliveries.read': ALL,
  'deliveries.write': PLANT,
  'deliveries.bl_return': ALL,
  // Stock movements, physical count, plant import
  'stock.read': PLANT,
  'stock.write': PLANT,
  'reconciliation.close': MANAGERS,
  // Derived figures
  'margins.read': MANAGERS,
  'cash.read': MANAGERS,
  'alerts.risk.read': MANAGERS,
  'alerts.reclassify': MANAGERS,
  'due_items.read': OFFICE,
  'alerts.stock.read': PLANT,
  'accounts.colour.read': OFFICE,
  // Audit log viewer
  'audit.read_all': MANAGERS,
  'audit.read_own': ALL,
  // AI (🟡 A22)
  'ai.qa': MANAGERS,
  'ai.assisted_entry': OFFICE,
  // Pilot operations
  'simulation.control': ['owner'],
  'backups.manage': ['owner'],
  'checklist.manage': ['owner'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function rolesWith(permission: Permission): readonly Role[] {
  return Object.hasOwn(PERMISSIONS, permission) ? PERMISSIONS[permission] : [];
}

export function can(role: Role, permission: Permission): boolean {
  return (rolesWith(permission) as readonly string[]).includes(role);
}
