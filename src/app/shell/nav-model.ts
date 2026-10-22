import { can, type Permission, type Role } from '@/modules/platform-security';

/** One link of the sidebar. `path` is relative to the locale ('' = home). */
interface NavDef {
  path: string;
  labelKey: string;
  testId: string;
  icon: NavIcon;
  /** Permission needed to see the link; a function for the few role-only pages. */
  allowed: Permission | ((role: Role) => boolean);
}
export type NavIcon = 'home' | 'sales' | 'purchases' | 'production' | 'data' | 'admin';

interface GroupDef {
  id: 'dashboard' | 'sales' | 'purchases' | 'production' | 'masterData' | 'administration';
  items: NavDef[];
}

// Groups follow the business, not the tables: what we sell, what we buy, what we make, reference data, administration.
const GROUPS: GroupDef[] = [
  {
    id: 'dashboard',
    items: [
      { path: '', labelKey: 'shell.nav.dashboard', testId: 'home-link', icon: 'home', allowed: () => true },
    ],
  },
  {
    id: 'sales',
    items: [
      {
        path: '/master-data/clients',
        labelKey: 'masterData.clients.link',
        testId: 'clients-link',
        icon: 'sales',
        allowed: 'parties.read',
      },
      {
        path: '/master-data/selling-prices',
        labelKey: 'masterData.sellingPrices.link',
        testId: 'selling-prices-link',
        icon: 'sales',
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
        icon: 'purchases',
        allowed: 'parties.read',
      },
      {
        path: '/master-data/purchase-prices',
        labelKey: 'masterData.purchasePrices.link',
        testId: 'purchase-prices-link',
        icon: 'purchases',
        allowed: 'purchase_prices.read',
      },
    ],
  },
  {
    id: 'production',
    items: [
      {
        path: '/master-data/recettes',
        labelKey: 'masterData.recettes.link',
        testId: 'recettes-link',
        icon: 'production',
        allowed: 'recettes.read',
      },
      {
        path: '/master-data/trucks',
        labelKey: 'masterData.trucks.link',
        testId: 'trucks-link',
        icon: 'production',
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
        icon: 'data',
        allowed: 'zones.read',
      },
      {
        path: '/master-data/concrete-types',
        labelKey: 'masterData.concreteTypes.link',
        testId: 'concrete-types-link',
        icon: 'data',
        allowed: 'recettes.read',
      },
      {
        path: '/master-data/components',
        labelKey: 'masterData.components.link',
        testId: 'components-link',
        icon: 'data',
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
        icon: 'admin',
        allowed: 'users.manage',
      },
      {
        path: '/parameters',
        labelKey: 'parameters.link',
        testId: 'parameters-link',
        icon: 'admin',
        allowed: 'parameters.read',
      },
      {
        path: '/checklist',
        labelKey: 'checklist.link',
        testId: 'checklist-link',
        icon: 'admin',
        allowed: 'checklist.manage',
      },
      {
        path: '/historique',
        labelKey: 'history.link',
        testId: 'history-link',
        icon: 'admin',
        allowed: 'audit.read_own',
      },
      {
        path: '/security',
        labelKey: 'auth.security.link',
        testId: 'security-link',
        icon: 'admin',
        allowed: () => true,
      },
    ],
  },
];

export interface NavLink {
  href: string;
  label: string;
  testId: string;
  icon: NavIcon;
}
export interface NavGroup {
  id: GroupDef['id'];
  label: string;
  links: NavLink[];
}

/** The sidebar for a role: only the links it may open, groups with no link left are dropped. `t` resolves a message key. */
export function buildNav(role: Role, locale: string, t: (key: string) => string): NavGroup[] {
  return GROUPS.map((group) => ({
    id: group.id,
    label: group.id === 'dashboard' ? '' : t(`shell.nav.${group.id}`),
    links: group.items
      .filter((item) => (typeof item.allowed === 'function' ? item.allowed(role) : can(role, item.allowed)))
      .map((item) => ({
        href: `/${locale}${item.path}`,
        label: t(item.labelKey),
        testId: item.testId,
        icon: item.icon,
      })),
  })).filter((group) => group.links.length > 0);
}
