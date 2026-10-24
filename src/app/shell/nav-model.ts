import { can, type Permission, type Role } from '@/modules/platform-security';

/** One link of the navigation. `path` is relative to the locale ('' = home). */
interface NavDef {
  path: string;
  labelKey: string;
  testId: string;
  /** Permission needed to see the link; a function for the few role-only pages. */
  allowed: Permission | ((role: Role) => boolean);
}
interface GroupDef {
  id: 'dashboard' | 'sales' | 'purchases' | 'finance' | 'production' | 'masterData' | 'administration';
  items: NavDef[];
}

// Groups follow the business, not the tables: what we sell, what we buy, what we make, reference data, administration.
const GROUPS: GroupDef[] = [
  {
    id: 'dashboard',
    items: [{ path: '', labelKey: 'shell.nav.dashboard', testId: 'home-link', allowed: () => true }],
  },
  {
    id: 'sales',
    items: [
      {
        path: '/master-data/clients',
        labelKey: 'masterData.clients.link',
        testId: 'clients-link',
        allowed: 'parties.read',
      },
      {
        path: '/orders/new',
        labelKey: 'ledger.orders.link',
        testId: 'orders-new-link',
        allowed: 'orders.write',
      },
      {
        path: '/payments/new',
        labelKey: 'ledger.payments.link',
        testId: 'payments-new-link',
        allowed: 'instruments.write',
      },
      {
        path: '/master-data/selling-prices',
        labelKey: 'masterData.sellingPrices.link',
        testId: 'selling-prices-link',
        allowed: 'selling_prices.read',
      },
    ],
  },
  {
    id: 'purchases',
    items: [
      {
        path: '/master-data/suppliers',
        labelKey: 'masterData.suppliers.link',
        testId: 'suppliers-link',
        allowed: 'parties.read',
      },
      {
        path: '/master-data/purchase-prices',
        labelKey: 'masterData.purchasePrices.link',
        testId: 'purchase-prices-link',
        allowed: 'purchase_prices.read',
      },
    ],
  },
  {
    id: 'finance',
    items: [
      {
        path: '/accounts',
        labelKey: 'ledger.accounts.link',
        testId: 'accounts-link',
        allowed: 'money_accounts.read',
      },
      {
        path: '/statements',
        labelKey: 'ledger.statements.link',
        testId: 'statements-link',
        allowed: 'statements.read',
      },
      {
        path: '/instruments',
        labelKey: 'ledger.instruments.link',
        testId: 'instruments-link',
        allowed: 'instruments.read',
      },
      {
        path: '/opening',
        labelKey: 'ledger.opening.link',
        testId: 'opening-link',
        allowed: 'opening.read',
      },
      {
        path: '/cash',
        labelKey: 'ledger.cash.link',
        testId: 'cash-link',
        allowed: 'cash.read',
      },
    ],
  },
  {
    id: 'production',
    items: [
      {
        path: '/loads',
        labelKey: 'operations.loads.link',
        testId: 'loads-link',
        allowed: 'deliveries.read',
      },
      {
        path: '/stock',
        labelKey: 'operations.stock.link',
        testId: 'stock-link',
        allowed: 'stock.read',
      },
      {
        path: '/master-data/recettes',
        labelKey: 'masterData.recettes.link',
        testId: 'recettes-link',
        allowed: 'recettes.read',
      },
      {
        path: '/master-data/trucks',
        labelKey: 'masterData.trucks.link',
        testId: 'trucks-link',
        allowed: 'trucks.read',
      },
    ],
  },
  {
    id: 'masterData',
    items: [
      {
        path: '/master-data/zones',
        labelKey: 'masterData.zones.link',
        testId: 'zones-link',
        allowed: 'zones.read',
      },
      {
        path: '/master-data/concrete-types',
        labelKey: 'masterData.concreteTypes.link',
        testId: 'concrete-types-link',
        allowed: 'recettes.read',
      },
      {
        path: '/master-data/components',
        labelKey: 'masterData.components.link',
        testId: 'components-link',
        allowed: 'components.read',
      },
    ],
  },
  {
    id: 'administration',
    items: [
      {
        path: '/admin/users',
        labelKey: 'admin.link',
        testId: 'admin-link',
        allowed: 'users.manage',
      },
      {
        path: '/parameters',
        labelKey: 'parameters.link',
        testId: 'parameters-link',
        allowed: 'parameters.read',
      },
      {
        path: '/checklist',
        labelKey: 'checklist.link',
        testId: 'checklist-link',
        allowed: 'checklist.manage',
      },
      {
        path: '/historique',
        labelKey: 'history.link',
        testId: 'history-link',
        allowed: 'audit.read_own',
      },
      {
        path: '/security',
        labelKey: 'auth.security.link',
        testId: 'security-link',
        allowed: () => true,
      },
    ],
  },
];

export interface NavLink {
  href: string;
  label: string;
  testId: string;
}
export interface NavGroup {
  id: GroupDef['id'];
  /** The tab label. The dashboard group is a single page: its label is that page's. */
  label: string;
  links: NavLink[];
}

/** The navigation for a role: only the links it may open, groups with no link left are dropped. `t` resolves a message key. */
export function buildNav(role: Role, locale: string, t: (key: string) => string): NavGroup[] {
  return GROUPS.map((group) => ({
    id: group.id,
    label: t(`shell.nav.${group.id}`),
    links: group.items
      .filter((item) => (typeof item.allowed === 'function' ? item.allowed(role) : can(role, item.allowed)))
      .map((item) => ({
        href: `/${locale}${item.path}`,
        label: t(item.labelKey),
        testId: item.testId,
      })),
  })).filter((group) => group.links.length > 0);
}
