import { describe, expect, it } from 'vitest';
import { buildNav } from './nav-model';

const t = (key: string) => key;
const links = (role: Parameters<typeof buildNav>[0]) =>
  buildNav(role, 'fr', t).flatMap((g) => g.links.map((l) => l.href.replace('/fr', '') || '/'));

describe('sidebar navigation by role', () => {
  it('the owner sees every page', () => {
    expect(links('owner')).toEqual(
      expect.arrayContaining([
        '/',
        '/master-data/clients',
        '/master-data/suppliers',
        '/admin/users',
        '/parameters',
        '/checklist',
      ]),
    );
  });

  it('office sees sales and purchases pages, not administration of users, parameters or the checklist', () => {
    const office = links('office');
    expect(office).toEqual(
      expect.arrayContaining(['/master-data/clients', '/master-data/suppliers', '/historique']),
    );
    expect(office).not.toContain('/admin/users');
    expect(office).not.toContain('/parameters');
    expect(office).not.toContain('/checklist');
  });

  it('plant sees no client, supplier or price page, and the empty groups disappear', () => {
    const plant = links('plant');
    for (const hidden of [
      '/master-data/clients',
      '/master-data/suppliers',
      '/master-data/selling-prices',
      '/master-data/purchase-prices',
    ]) {
      expect(plant).not.toContain(hidden);
    }
    expect(plant).toEqual(expect.arrayContaining(['/master-data/recettes', '/master-data/trucks']));
    const groups = buildNav('plant', 'fr', t).map((g) => g.id);
    expect(groups).not.toContain('sales');
    expect(groups).not.toContain('purchases');
  });

  it('prefixes every link with the locale', () => {
    for (const g of buildNav('owner', 'ar', t))
      for (const l of g.links) expect(l.href.startsWith('/ar')).toBe(true);
  });
});
