import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS, rolesWith, USER_ROLES } from './permissions';

// One row per line of SPEC-platform-security §4 (spot checks of the encoding).
describe('permission matrix (SPEC-platform-security §4)', () => {
  it.each([
    ['users.manage', ['owner']],
    ['parameters.read', ['owner', 'partner', 'support']],
    ['parameters.write', ['owner']],
    ['parties.write', ['owner', 'partner', 'office']],
    ['recettes.read', ['owner', 'partner', 'office', 'plant', 'support']],
    ['recettes.write', ['owner', 'partner']],
    ['purchase_prices.read', ['owner', 'support']],
    ['purchase_prices.write', ['owner']],
    ['selling_prices.write', ['owner']],
    ['client_price_override.write', ['owner']],
    ['trucks.status.write', ['owner', 'partner', 'plant']],
    ['orders.read', ['owner', 'partner', 'plant', 'support']],
    ['orders.read_money', ['owner', 'support']],
    ['orders.write', ['owner', 'office']],
    ['instruments.read', ['owner', 'support']],
    ['instruments.write', ['owner', 'office']],
    ['invoices.read', ['owner', 'support']],
    ['purchases.read', ['owner', 'plant', 'support']],
    ['purchases.read_money', ['owner', 'support']],
    ['ledger.reverse', ['owner']],
    ['corrections.request', ['owner', 'office']],
    ['deliveries.write', ['owner', 'partner', 'plant']],
    ['deliveries.bl_return', ['owner', 'partner', 'office', 'plant']],
    ['stock.write', ['owner', 'partner', 'plant']],
    ['stock.read', ['owner', 'partner', 'plant', 'support']],
    ['margins.read', ['owner', 'support']],
    ['cash.read', ['owner', 'support']],
    ['alerts.reclassify', ['owner']],
    ['due_items.read', ['owner', 'support']],
    ['alerts.stock.read', ['owner', 'partner', 'plant', 'support']],
    ['accounts.colour.read', ['owner', 'support']],
    ['audit.read_all', ['owner', 'partner', 'support']],
    ['audit.read_own', ['owner', 'partner', 'office', 'plant', 'support']],
    ['ai.qa', ['owner', 'support']],
    ['ai.assisted_entry', ['owner', 'partner', 'office']],
    ['assistant.use', ['owner', 'partner', 'office', 'plant', 'support']],
    ['simulation.control', ['owner']],
    ['backups.manage', ['owner']],
  ])('%s → %j', (permission, roles) => {
    expect([...rolesWith(permission as never)].sort()).toEqual([...roles].sort());
  });

  it('denies by default: an unknown permission is granted to nobody', () => {
    for (const role of USER_ROLES) expect(can(role, 'nonexistent.permission' as never)).toBe(false);
  });

  it('never grants anything to the system or anonymous actors through the user matrix', () => {
    for (const permission of Object.keys(PERMISSIONS)) {
      expect(can('anonymous' as never, permission as never)).toBe(false);
    }
  });

  it('only the owner may manage users', () => {
    expect(USER_ROLES.filter((r) => can(r, 'users.manage'))).toEqual(['owner']);
  });

  // DECISIONS 81 (provisional): money visibility.
  const WRITES = Object.keys(PERMISSIONS).filter((p) =>
    /\.(write|price_override|reverse|reverse_old|reclassify|close|manage|control|bl_return|request|archive|ice_override|step_up)$|^trucks\.status\.write$|^ai\.assisted_entry$/.test(
      p,
    ),
  );

  it('support can read but never write, confirm or post anything', () => {
    expect(WRITES.length).toBeGreaterThan(15);
    for (const permission of WRITES) expect(can('support', permission as never), permission).toBe(false);
    expect(can('support', 'audit.read_all')).toBe(true);
    expect(can('support', 'cash.read')).toBe(true);
  });

  const MONEY = [
    'purchase_prices.read',
    'selling_prices.read',
    'orders.read_money',
    'instruments.read',
    'invoices.read',
    'purchases.read_money',
    'margins.read',
    'cash.read',
    'due_items.read',
    'accounts.colour.read',
    'corrections.read',
    'ai.qa',
  ] as const;

  it('only the owner and support read money; partner, office and plant read none of it', () => {
    for (const permission of MONEY) {
      expect([...rolesWith(permission)].sort(), permission).toEqual(['owner', 'support']);
    }
  });

  it('office writes money blind: it can create but holds no money read permission', () => {
    expect(can('office', 'orders.write')).toBe(true);
    expect(can('office', 'invoices.write')).toBe(true);
    expect(can('office', 'instruments.write')).toBe(true);
    expect(can('office', 'purchases.write')).toBe(true);
    for (const permission of MONEY) expect(can('office', permission), permission).toBe(false);
    expect(can('office', 'ledger.reverse')).toBe(false);
  });

  it('only the owner writes prices, overrides and reversals', () => {
    for (const permission of [
      'purchase_prices.write',
      'selling_prices.write',
      'client_price_override.write',
      'orders.price_override',
      'ledger.reverse',
      'ledger.reverse_old',
    ] as const) {
      expect([...rolesWith(permission)], permission).toEqual(['owner']);
    }
  });

  it('the plant and the partner reach no money permission, only the operational order fields', () => {
    for (const role of ['plant', 'partner'] as const) {
      for (const permission of MONEY) expect(can(role, permission), `${role} ${permission}`).toBe(false);
      expect(can(role, 'orders.read')).toBe(true);
    }
  });
});
