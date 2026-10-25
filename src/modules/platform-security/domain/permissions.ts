/**
 * The RBAC matrix of SPEC-platform-security §4, as data. Route guards, service guards and the RLS test matrix all
 * read this one table. Default deny: a permission not listed here is granted to nobody.
 * Field-level restrictions inside a permission (e.g. plant sees orders without prices) live in field-visibility.ts.
 */
export const USER_ROLES = ['owner', 'partner', 'office', 'plant', 'support'] as const;
export type Role = (typeof USER_ROLES)[number];

// DECISIONS 81 (provisional): `support` reads everything and writes nothing, so it joins every read list and no write
// list. Money (prices, balances, totals, instruments, invoices) is read by the owner and support only; the partner has
// no money access for now; office writes money blind (it never reads it back); plant sees no money.
const ALL = ['owner', 'partner', 'office', 'plant', 'support'] as const;
const MANAGERS = ['owner', 'partner'] as const;
const MANAGERS_READ = ['owner', 'partner', 'support'] as const;
const OFFICE = ['owner', 'partner', 'office'] as const;
const OFFICE_READ = ['owner', 'partner', 'office', 'support'] as const;
const PLANT_READ = ['owner', 'partner', 'plant', 'support'] as const;
const PLANT = ['owner', 'partner', 'plant'] as const;
/** Money: read by the owner and support; written by the owner. */
const MONEY_READ = ['owner', 'support'] as const;
const MONEY_WRITE = ['owner'] as const;
/** Blind entry: office (and the owner) create money records and never read them back. */
const BLIND_WRITE = ['owner', 'office'] as const;

export const PERMISSIONS = {
  // Users, roles, 2FA reset
  'users.manage': ['owner'],
  // Parameters
  'parameters.read': MANAGERS_READ,
  'parameters.write': ['owner'],
  // Clients / suppliers
  'parties.read': OFFICE_READ,
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
  'purchase_prices.read': MONEY_READ,
  'purchase_prices.write': MONEY_WRITE,
  // Selling prices, per-client overrides (✅ A27)
  'selling_prices.read': MONEY_READ,
  'selling_prices.write': MONEY_WRITE,
  'client_price_override.write': MONEY_WRITE,
  // Trucks, zones
  'trucks.read': ALL,
  'trucks.write': MANAGERS,
  'trucks.status.write': PLANT,
  'zones.read': ALL,
  'zones.write': MANAGERS,
  // Orders + payment plan: operational fields (code, type, m³, date, site/zone) for the partner and the plant, amounts
  // for the owner and support; office writes blind (field-visibility.ts)
  'orders.read': ['owner', 'partner', 'plant', 'support'],
  'orders.read_money': MONEY_READ,
  'orders.write': BLIND_WRITE,
  'orders.price_override': MONEY_WRITE,
  // Caisse and bank accounts with their opening balances (owner writes; owner and support read)
  'money_accounts.read': MONEY_READ,
  'money_accounts.write': MONEY_WRITE,
  // Account statements of clients and suppliers (owner and support; each view is audited for support)
  'statements.read': MONEY_READ,
  // The opening state: the date and what clients and suppliers owe on it (owner enters once)
  'opening.read': MONEY_READ,
  'opening.write': MONEY_WRITE,
  // Payment instruments, money account entries
  'instruments.read': MONEY_READ,
  'instruments.write': BLIND_WRITE,
  // Deposit, clear, bounce, regularize, dispute and cancel confirm money: the owner's
  'instruments.manage': MONEY_WRITE,
  // Invoices
  'invoices.read': MONEY_READ,
  'invoices.write': BLIND_WRITE,
  // Purchases, supplier payments (plant: receipt lines, no amount)
  'purchases.read': ['owner', 'plant', 'support'],
  'purchases.read_money': MONEY_READ,
  'purchases.write': BLIND_WRITE,
  // Reversing entries are the owner's; office asks for a correction instead (it cannot read what it entered)
  'ledger.reverse': MONEY_WRITE,
  'ledger.reverse_old': MONEY_WRITE,
  'corrections.request': BLIND_WRITE,
  'corrections.read': ['owner', 'support'],
  // Our legal identity: printed on every document, so everyone reads it; the owner changes it
  'company.read': ALL,
  'company.write': MONEY_WRITE,
  // Deliveries / BL (✅ A11)
  'deliveries.read': ALL,
  'deliveries.write': PLANT,
  // Cancelling a load writes a reversing row and reversing stock movements: managers
  'deliveries.cancel': MANAGERS,
  'deliveries.bl_return': ['owner', 'partner', 'office', 'plant'],
  // Stock movements, physical count, plant import
  'stock.read': PLANT_READ,
  'stock.write': PLANT,
  // The opening stock of a component (entered once, with a date), and the low-stock threshold per component
  'stock.opening': MANAGERS,
  'stock.threshold': MANAGERS,
  // Receiving a purchase puts its stocked lines into the stock; quantities only, no amount
  'receipts.read': PLANT_READ,
  'receipts.write': PLANT,
  'reconciliation.close': MANAGERS,
  // Derived figures
  'margins.read': MONEY_READ,
  'cash.read': MONEY_READ,
  // The accountant's files for a period (owner and support; every download is audited as an export)
  'accounting.export': MONEY_READ,
  // The money facts of "what did this action change" (ledger L35): the roles that read money
  'effects.money': MONEY_READ,
  // Security alerts (break-glass) are not money: owner and partner see and acknowledge them (support reads the table).
  'alerts.risk.read': MANAGERS,
  'alerts.reclassify': MONEY_WRITE,
  'due_items.read': MONEY_READ,
  'alerts.stock.read': PLANT_READ,
  'accounts.colour.read': MONEY_READ,
  // Audit log viewer
  'audit.read_all': MANAGERS_READ,
  'audit.read_own': ALL,
  // AI (🟡 A22)
  'ai.qa': MONEY_READ,
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
