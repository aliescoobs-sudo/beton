import { describe, expect, it } from 'vitest';
import { findCurrent, initialOpenId, isDirect, matchLinks, toggleSection } from './drawer-model';
import { buildNav } from './nav-model';

import fr from '../../../messages/fr.json';

// the real French labels, so that a query is matched against what the user reads
const t = (key: string) =>
  key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], fr) as string;
const owner = buildNav('owner', 'fr', t);
const sales = buildNav('office_sales', 'fr', t);

describe('phone drawer accordion model', () => {
  it('opens the section holding the current route, and none for a single-link section', () => {
    expect(initialOpenId(owner, '/fr/master-data/clients/123')).toBe('sales');
    expect(initialOpenId(owner, '/fr/admin/users')).toBe('administration');
    // the dashboard has one link: a direct link, never an accordion
    expect(isDirect(owner.find((g) => g.id === 'dashboard')!)).toBe(true);
    expect(initialOpenId(owner, '/fr')).toBeNull();
    expect(initialOpenId(owner, '/fr/unknown-page')).toBeNull();
  });

  it('keeps the longest match as the current link', () => {
    expect(findCurrent(owner, '/fr/documents/requests')?.link.href).toBe('/fr/documents/requests');
    expect(findCurrent(owner, '/fr/documents')?.link.href).toBe('/fr/documents');
  });

  it('opens one section at a time and closes the open one when tapped again', () => {
    let open: string | null = null;
    open = toggleSection(open, 'sales');
    expect(open).toBe('sales');
    open = toggleSection(open, 'purchases');
    expect(open).toBe('purchases');
    open = toggleSection(open, 'purchases');
    expect(open).toBeNull();
  });

  it('a typed query lists matching links of every section, with the section name, accents ignored', () => {
    const m = matchLinks(owner, 'COMMANDES');
    expect(m.length).toBeGreaterThan(0);
    for (const x of m) expect(x.groupLabel).toBeTruthy();
    expect(matchLinks(owner, '   ')).toEqual([]);
    // the same labels with and without accents match the same links
    expect(
      matchLinks(
        [
          { id: 'sales', label: 'Ventes', links: [{ href: '/fr/a', label: 'Échéances', testId: 'x' }] },
        ] as never,
        'echeances',
      ),
    ).toHaveLength(1);
  });

  it('never shows a link the role was not given: it only reads the groups it receives', () => {
    const hrefs = sales.flatMap((g) => g.links.map((l) => l.href));
    expect(hrefs).not.toContain('/fr/admin/users');
    const found = matchLinks(sales, 'users').map((m) => m.href);
    expect(found).not.toContain('/fr/admin/users');
    for (const m of matchLinks(sales, 'a')) expect(hrefs).toContain(m.href);
  });
});
