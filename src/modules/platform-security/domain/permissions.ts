/**
 * The RBAC matrix of SPEC-platform-security §4, as data. Route guards, service guards and the RLS test matrix all
 * read this one table. Default deny: a permission not listed here is granted to nobody.
 * Field-level restrictions inside a permission (e.g. plant sees orders without prices) live in field-visibility.ts.
 */
export const USER_ROLES = [
  'owner',
  'partner',
  'office',
  'plant',
  'support',
  // V1 (DECISIONS 126): mapped to a policy role by the database (ctx.role()), see migration 0082.
  'app_admin',
  'office_sales',
  'office_purchases',
  'plant_manager',
  'driver',
  'pump_operator',
  'accountant',
  'client_portal',
  'supplier_portal',
] as const;
/** The five roles every RLS policy of the pilot is written for; a V1 role is mapped to one of them (or to none). */
export const POLICY_ROLES = ['owner', 'partner', 'office', 'plant', 'support'] as const;
export type PolicyRole = (typeof POLICY_ROLES)[number];
export const V1_POLICY_ROLE: Partial<Record<(typeof USER_ROLES)[number], PolicyRole>> = {
  app_admin: 'owner',
  office_sales: 'office',
  office_purchases: 'office',
  plant_manager: 'plant',
};
export type Role = (typeof USER_ROLES)[number];

/** The policy role an account is read as (the database does the same in ctx.role()); null when it has none. */
export function policyRoleOf(role: Role): PolicyRole | null {
  return (POLICY_ROLES as readonly string[]).includes(role)
    ? (role as PolicyRole)
    : (V1_POLICY_ROLE[role] ?? null);
}

// DECISIONS 81 (provisional): `support` reads everything and writes nothing, so it joins every read list and no write
// list. Money (prices, balances, totals, instruments, invoices) is read by the owner and support only; the partner has
// no money access for now; office writes money blind (it never reads it back); plant sees no money.
const ALL = [
  'owner',
  'app_admin',
  'partner',
  'office',
  'office_sales',
  'office_purchases',
  'plant',
  'plant_manager',
  'support',
] as const;
const MANAGERS = ['owner', 'app_admin', 'partner'] as const;
const MANAGERS_READ = ['owner', 'app_admin', 'partner', 'support'] as const;
const OFFICE = ['owner', 'app_admin', 'partner', 'office', 'office_sales', 'office_purchases'] as const;
const OFFICE_READ = [
  'owner',
  'app_admin',
  'partner',
  'office',
  'office_sales',
  'office_purchases',
  'support',
] as const;
const PLANT_READ = ['owner', 'app_admin', 'partner', 'plant', 'plant_manager', 'support'] as const;
const PLANT = ['owner', 'app_admin', 'partner', 'plant', 'plant_manager'] as const;
/**
 * Driver and truck tracking (steps, started flag, the dispatch board): owner/app_admin and the plant manager (of that plant: the scope is enforced
 * by the database). `partner` and `support` have no accounts in V1 (decision of the owner, T8) and are not listed here.
 */
const TRACKING = ['owner', 'app_admin', 'plant', 'plant_manager'] as const;
/** Money: read by the owner and support; written by the owner. */
const MONEY_READ = ['owner', 'app_admin', 'support'] as const;
const MONEY_WRITE = ['owner', 'app_admin'] as const;
/** Blind entry: office (and the owner) create money records and never read them back. */
/** Sales and purchases are two offices (DECISIONS 128): each writes its own documents, blind, and never the other's. */
const BLIND_SALES = ['owner', 'app_admin', 'office', 'office_sales'] as const;
const BLIND_PURCHASES = ['owner', 'app_admin', 'office', 'office_purchases'] as const;
const BLIND_WRITE = ['owner', 'app_admin', 'office', 'office_sales', 'office_purchases'] as const;

export const PERMISSIONS = {
  // Users, roles, 2FA reset
  'users.manage': ['owner', 'app_admin'],
  // Parameters
  'parameters.read': MANAGERS_READ,
  'parameters.write': ['owner', 'app_admin'],
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
  // Plants (REQUIREMENTS-V1 §1): every internal role reads; managers write
  'plants.read': ALL,
  'plants.write': MANAGERS,
  // The phone number of a plant (the driver's tel: link): the owner and app_admin only
  'plants.phone': ['owner', 'app_admin'],
  // The driver and pump phone app (R4): accounts, PINs and phones are the owner's and app_admin's; the office handles emergencies
  'field.admin': ['owner', 'app_admin'],
  'field.emergencies': [
    'owner',
    'app_admin',
    'partner',
    'office',
    'office_sales',
    'office_purchases',
    'plant',
    'plant_manager',
    'support',
  ],
  'field.instruct': ['owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager'],
  // C3 (§16.6): a pumped pour needs a pump scheduled on site before a truck is planned; the board is read by the same roles and support
  'pumps.plan': ['owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager'],
  'pumps.read': [
    'owner',
    'app_admin',
    'partner',
    'office',
    'office_sales',
    'plant',
    'plant_manager',
    'support',
  ],
  'field.pump_plan': ['owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager'],
  // Trucks, zones
  'trucks.read': ALL,
  'trucks.write': MANAGERS,
  'trucks.status.write': PLANT,
  'zones.read': ALL,
  'zones.write': MANAGERS,
  // Orders + payment plan: operational fields (code, type, m³, date, site/zone) for the partner and the plant, amounts
  // for the owner and support; office writes blind (field-visibility.ts)
  'orders.read': ['owner', 'app_admin', 'partner', 'plant', 'plant_manager', 'support'],
  'orders.read_money': MONEY_READ,
  // The order chain: quantities and stages for every role of the company; the payment stage only for the money roles.
  'orders.chain': ALL,
  // Search by document number: every role; what it finds is whatever its row-level security lets it read.
  'search.number': ALL,
  'orders.write': BLIND_SALES,
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
  // Quotes: office and the owner write (office blind), the owner and support read and print
  'quotes.read': MONEY_READ,
  'quotes.write': BLIND_SALES,
  // Approvals inbox (R3): provisional prices and held orders. Owner and app_admin decide; support reads.
  'approvals.read': MONEY_READ,
  'approvals.decide': MONEY_WRITE,
  'credit_limit.write': MONEY_WRITE,
  // Whether an order waits, and a client's standing as two flags: no figure, so the offices read them.
  // R5: the notification centre is for every signed-in internal account (a driver or pump operator reaches push only through the phone app's own session door).
  'notifications.read': [...ALL, 'accountant'],
  // R8: every account chooses its own main language (Arabic, French, Darija)
  'account.locale': [...ALL, 'accountant'],
  // Cancellations and incidents (R6, §8): the offices cancel, the plant reports incidents, owner and app_admin decide (the plant
  // manager only when the owner's policy allows it, checked in the database).
  // Documents (R7, §9): the gate for number-bearing documents a client asks for, the timing of the final invoice (the accountant
  // chooses), and the continuation of the invoice numbering.
  'documents.request': ['office', 'office_sales', 'office_purchases', 'accountant'],
  'documents.decide': MONEY_WRITE,
  'documents.policy': ['owner', 'app_admin', 'accountant'],
  'documents.sequence': MONEY_WRITE,
  // Plant flows (§16.5, §16.8, §16.9): transfers between the plants, the timeline of an order, the day close per plant.
  'transfers.read': ['owner', 'app_admin', 'support', 'partner', 'plant', 'plant_manager'],
  'transfers.write': ['owner', 'app_admin', 'plant_manager'],
  'timeline.read': [...ALL, 'accountant'],
  'dayclose.read': ['owner', 'app_admin', 'support', 'partner', 'plant', 'plant_manager'],
  'dayclose.write': ['owner', 'app_admin', 'plant_manager'],
  'cancellations.read': ALL,
  'cancellations.open': ['owner', 'app_admin', 'partner', 'office', 'office_sales', 'plant', 'plant_manager'],
  'cancellations.decide': ['owner', 'app_admin', 'plant_manager'],
  'cancellations.policy': MONEY_WRITE,
  // §16.3: a person without money access asks for one figure; the owner or app_admin decides, scoped and audited.
  'disclosure.request': ['office', 'office_sales', 'office_purchases', 'plant', 'plant_manager'],
  'disclosure.decide': MONEY_WRITE,
  // §16.2: the document library. One key per document type; the library lists, and a download re-checks the key and the RLS.
  'documents.read': [...ALL, 'accountant'],
  'documents.invoice': [...MONEY_READ, 'accountant', 'office', 'office_sales'],
  // §16.1: the reference average prices (list sell, current buy) are seen by every internal non-field account.
  'reference_prices.read': [
    'owner',
    'app_admin',
    'office',
    'office_sales',
    'office_purchases',
    'plant',
    'plant_manager',
    'support',
  ],
  'orders.approval_state': ['owner', 'app_admin', 'office', 'office_sales', 'support'],
  'clients.balance_status': ['owner', 'app_admin', 'office', 'office_sales', 'office_purchases', 'support'],
  // Invoices
  'invoices.read': [...MONEY_READ, 'accountant'],
  'invoices.write': BLIND_SALES,
  // The supplier's invoice, its own document linked to the order and the receipts: entered blind by office, read by owner and support.
  'supplier_invoices.read': MONEY_READ,
  'supplier_invoices.write': BLIND_PURCHASES,
  // Accept the gaps, approve for payment (the payable), reject: the owner, the first two after a fresh second factor.
  'supplier_invoices.approve': MONEY_WRITE,
  // The avoir for concrete refused or brought back after it was billed: the owner issues it (step-up), the owner and support read.
  'avoirs.read': [...MONEY_READ, 'accountant'],
  'avoirs.issue': MONEY_WRITE,
  // The delivered loads no invoice carries yet. Office reads it without any amount (the answer has no money key).
  'invoices.queue': ['owner', 'app_admin', 'office', 'office_sales', 'support'],
  // Purchases, supplier payments (plant: receipt lines, no amount)
  'purchases.read': ['owner', 'app_admin', 'plant', 'plant_manager', 'support'],
  'purchases.read_money': MONEY_READ,
  'purchases.write': BLIND_PURCHASES,
  // Reversing entries are the owner's; office asks for a correction instead (it cannot read what it entered)
  'ledger.reverse': MONEY_WRITE,
  'ledger.reverse_old': MONEY_WRITE,
  'corrections.request': BLIND_WRITE,
  'corrections.read': ['owner', 'app_admin', 'support'],
  // Our legal identity: printed on every document, so everyone reads it; the owner changes it
  'company.read': [...ALL, 'accountant'],
  'company.write': MONEY_WRITE,
  // Deliveries / BL (✅ A11)
  'deliveries.read': ALL,
  'deliveries.write': PLANT,
  // Cancelling a load writes a reversing row and reversing stock movements: managers
  'deliveries.cancel': MANAGERS,
  // A load beyond the order volume is recorded; the owner confirms it (it will be billed at the order's price)
  'deliveries.excess_read': ['owner', 'app_admin', 'partner', 'support'],
  'deliveries.excess_confirm': MONEY_WRITE,
  'deliveries.bl_return': [
    'owner',
    'app_admin',
    'partner',
    'office',
    'office_sales',
    'office_purchases',
    'plant',
    'plant_manager',
  ],
  // A load made outside a rotation is marked delivered by hand; a rotation's load is delivered by its tracking step
  'deliveries.deliver': ['owner', 'app_admin', 'partner', 'plant', 'plant_manager'],
  // The scan of a signed BL: add it (with the return, or after), and open it. Opening re-checks RLS and is audited.
  'delivery_files.write': [
    'owner',
    'app_admin',
    'partner',
    'office',
    'office_sales',
    'office_purchases',
    'plant',
    'plant_manager',
  ],
  // C3: the photo of the signed BL taken by the driver on the phone. Read by the offices, the owner roles, the plant and support.
  'driver_bl_photos.read': [
    'owner',
    'app_admin',
    'office',
    'office_sales',
    'office_purchases',
    'plant',
    'plant_manager',
    'support',
  ],
  'delivery_files.read': [
    'owner',
    'app_admin',
    'partner',
    'office',
    'office_sales',
    'office_purchases',
    'plant',
    'plant_manager',
    'support',
  ],
  // Concrete that came back or was refused, recorded on its load with a reason (counted as loss in the consumption report)
  'deliveries.loss': [
    'owner',
    'app_admin',
    'partner',
    'office',
    'office_sales',
    'office_purchases',
    'plant',
    'plant_manager',
  ],
  // Daily dispatch: the plan of the day's rotations (truck, driver, times); quantities and times only. Office is blind to orders.
  'dispatch.read': TRACKING,
  'dispatch.write': TRACKING,
  // Office's read-only view of the day's rotations: truck, times, litres, client name, the step reached. No price, no order.
  'dispatch.read_office': ['office', 'office_sales'],
  'drivers.write': MANAGERS,
  // Trip tracking: one tap per step of a rotation (the first one is the load, so the plant's rights); times and quantities only.
  'trips.read': TRACKING,
  'trips.track': TRACKING,
  // T9: the time of a recorded stage is corrected (a new row, a reason, the audit log) by the same roles; the database re-checks the plant
  // (office_sales holds this one right and no other dispatch power: it can neither plan, nor reassign, nor postpone, nor read the board)
  'trips.correct': [...TRACKING, 'office_sales'],
  // Production and consumption report: quantities only (litres, grams), so the plant and the partner read it
  'reports.consumption': PLANT_READ,
  // Fuel per truck: litres and kilometres are quantities (plant, owner, partner record; support reads); the purchases and
  // the cost per litre and per m³ are money (the owner enters the purchases, the owner and support read the costs).
  'fuel.read': PLANT_READ,
  'fuel.write': PLANT,
  'fuel.money': MONEY_READ,
  'fuel.purchase': MONEY_WRITE,
  // Sales volume analytics: m³ delivered per day, week, month and per client, type, zone (owner, partner, support);
  // the amounts (m³ × the order's price) are money: owner and support only.
  'analytics.read': MANAGERS_READ,
  'analytics.money': MONEY_READ,
  // T11 (decision 211): the imported HISTORY of deliveries and expenses, a separate flagged layer. The staging screens (labels to merge or map,
  // quarantined rows, the reconciliation) are the owner's and the app_admin's. Quantities of the history are read by them and by the plant
  // manager of the plant (the database scopes it; a row with no plant is not his). The expense history is money: owner, app_admin, accountant.
  // Office roles, drivers and pump operators have none; partner and support have no accounts in V1.
  'history.admin': ['owner', 'app_admin'],
  'history.read': ['owner', 'app_admin', 'plant', 'plant_manager'],
  // the page itself: the quantities for the roles above, the expense history for the money roles (each section checks its own right)
  'history.view': ['owner', 'app_admin', 'plant', 'plant_manager', 'accountant'],
  'history.money': ['owner', 'app_admin', 'accountant'],
  // Stock movements, physical count, plant import
  'stock.read': PLANT_READ,
  'stock.write': PLANT,
  // The opening stock of a component (entered once, with a date), and the low-stock threshold per component
  // The owner corrects the stock after a physical count (a movement with a reason)
  'stock.count': ['owner', 'app_admin'],
  // T15 (SPEC-stock-engine-gaps §5): the plant manager proposes a count of his own plant; in tolerance it posts, out of tolerance the owner decides
  'stock.count.propose': ['plant_manager'],
  // T15 (SPEC-stock-engine-gaps §6): the plant manager asks for a component of his plant; office_purchases reads every request and links it to a purchase (quantities only)
  // T15 G3 (SPEC-sms-channel §4): who registers a driver phone number and a vehicle's GPS unit (the numbers are personal data: owner and app_admin only)
  'sms.sender.manage': ['owner', 'app_admin'],
  // T16 G5 (SPEC-cost-margin §9, D236): cost rates, fuel norms, delivered transport and the price grid are cost data for the owner roles only (any widening needs a later numbered decision)
  'costs.manage': ['owner', 'app_admin'],
  // T17 G8 (D239): the selling-price GRID as a reference next to an order's price. A selling price, not a cost: office_sales reads it (door price_grid_list); no cost figure comes with it
  // T17 G9 (SPEC-cost-margin §9, §10): the margin read doors and the /margins screen: costs, margins and snapshots are owner and app_admin only (D236)
  'bl_margins.read': ['owner', 'app_admin'],
  'grid.read': ['owner', 'app_admin', 'office_sales'],
  'reorder.create': ['plant_manager'],
  'reorder.read': ['owner', 'app_admin', 'plant', 'plant_manager', 'office_purchases'],
  'reorder.handle': ['owner', 'app_admin', 'office_purchases'],
  'stock.opening': MANAGERS,
  'stock.threshold': MANAGERS,
  // Receiving a purchase puts its stocked lines into the stock; quantities only, no amount
  'receipts.read': [...PLANT_READ, 'office_purchases'],
  'receipts.write': [...PLANT, 'office_purchases'],
  // First step of the two-step receipt: the plant confirms an arrival (nothing enters the stock yet)
  'receipts.confirm_arrival': PLANT,
  'reconciliation.close': MANAGERS,
  // Derived figures
  'margins.read': MONEY_READ,
  'cash.read': MONEY_READ,
  // The accountant's files for a period (owner and support; every download is audited as an export)
  'accounting.export': [...MONEY_READ, 'accountant'],
  // The money facts of "what did this action change" (ledger L35): the roles that read money
  'effects.money': MONEY_READ,
  // Security alerts (break-glass) are not money: owner and partner see and acknowledge them (support reads the table).
  'alerts.risk.read': MANAGERS,
  'alerts.reclassify': MONEY_WRITE,
  'due_items.read': MONEY_READ,
  'alerts.stock.read': PLANT_READ,
  'accounts.colour.read': MONEY_READ,
  // Confirming a resolution option of the rules engine (early deposit, postponement…): money, the owner's (DECISIONS 81)
  'cash.decide': MONEY_WRITE,
  // Audit log viewer
  'audit.read_all': MANAGERS_READ,
  'audit.read_own': ALL,
  // AI (🟡 A22)
  'ai.qa': MONEY_READ,
  'ai.assisted_entry': OFFICE,
  // The in-app assistant (SPEC-assistant, v1.1: office included). What it can read or draft is each tool's own permission; this one is the entry.
  'assistant.use': ALL,
  // R10 (§11): the deterministic reports and the field surveys. Owner and app_admin create and read; each role answers its own.
  'reports.anomalies': ['owner', 'app_admin', 'support'],
  'surveys.read': [
    'owner',
    'app_admin',
    'support',
    'office',
    'office_sales',
    'office_purchases',
    'plant',
    'plant_manager',
    'accountant',
  ],
  'surveys.manage': MONEY_WRITE,
  'surveys.results': ['owner', 'app_admin', 'support'],
  'surveys.answer': ['office', 'office_sales', 'office_purchases', 'plant', 'plant_manager', 'accountant'],
  // Pilot operations
  'simulation.control': ['owner', 'app_admin'],
  'backups.manage': ['owner', 'app_admin'],
  'checklist.manage': ['owner', 'app_admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function rolesWith(permission: Permission): readonly Role[] {
  return Object.hasOwn(PERMISSIONS, permission) ? PERMISSIONS[permission] : [];
}

export function can(role: Role, permission: Permission): boolean {
  return (rolesWith(permission) as readonly string[]).includes(role);
}
