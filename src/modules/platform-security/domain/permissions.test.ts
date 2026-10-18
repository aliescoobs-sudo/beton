import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS, rolesWith, USER_ROLES } from './permissions';

// One row per line of SPEC-platform-security §4 (spot checks of the encoding).
describe('permission matrix (SPEC-platform-security §4)', () => {
  it.each([
    ['users.manage', ['owner']],
    ['parameters.read', ['owner', 'partner']],
    ['parameters.write', ['owner']],
    ['parties.write', ['owner', 'partner', 'office']],
    ['recettes.read', ['owner', 'partner', 'office', 'plant']],
    ['recettes.write', ['owner', 'partner']],
    ['purchase_prices.read', ['owner', 'partner', 'office']],
    ['selling_prices.write', ['owner', 'partner']],
    ['client_price_override.write', ['owner', 'partner']],
    ['trucks.status.write', ['owner', 'partner', 'plant']],
    ['orders.read', ['owner', 'partner', 'office', 'plant']],
    ['orders.write', ['owner', 'partner', 'office']],
    ['instruments.write', ['owner', 'partner', 'office']],
    ['purchases.read', ['owner', 'partner', 'office', 'plant']],
    ['deliveries.write', ['owner', 'partner', 'plant']],
    ['deliveries.bl_return', ['owner', 'partner', 'office', 'plant']],
    ['stock.write', ['owner', 'partner', 'plant']],
    ['margins.read', ['owner', 'partner']],
    ['cash.read', ['owner', 'partner']],
    ['alerts.reclassify', ['owner', 'partner']],
    ['due_items.read', ['owner', 'partner', 'office']],
    ['alerts.stock.read', ['owner', 'partner', 'plant']],
    ['accounts.colour.read', ['owner', 'partner', 'office']],
    ['audit.read_all', ['owner', 'partner']],
    ['audit.read_own', ['owner', 'partner', 'office', 'plant']],
    ['ai.qa', ['owner', 'partner']],
    ['ai.assisted_entry', ['owner', 'partner', 'office']],
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
});
