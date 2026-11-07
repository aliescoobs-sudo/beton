import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNav } from '../src/app/shell/nav-model';

// The role cards must only send a trainee to screens the role has. Checked against the real navigation of each role (nav-model),
// with the French labels of messages/fr.json.
const fr = JSON.parse(readFileSync('messages/fr.json', 'utf8')) as Record<string, unknown>;
const label = (key: string): string =>
  (key.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], fr) as string) ??
  key;
const navLabels = (role: string) =>
  buildNav(role as never, 'fr', label).flatMap((g) => g.links.map((l) => l.label));
const card = (name: string) => readFileSync(`docs/training/${name}.fr.md`, 'utf8');
/** The screens a card names: the *italic* spans, with "Group → Screen" reduced to the last part. */
const named = (text: string) =>
  [...text.replace(/\*\*[^*]+\*\*/g, '').matchAll(/\*([^*\n]+)\*/g)].map((m) =>
    m[1]!.split('→').pop()!.trim(),
  );

// Screens a card names ON PURPOSE as screens the role does NOT have ("you do not have *Devis*", "the plant manager sees it in *Stock*").
const NOT_OWNED: Record<string, string[]> = {
  ventes: ['Devis', 'Commandes'],
  achats: ['Factures fournisseurs', 'Stock'],
};

describe('the training cards name only screens the role has (T7 A2)', () => {
  it.each([
    ['ventes', 'office_sales'],
    ['achats', 'office_purchases'],
    ['centrale-tetouan', 'plant_manager'],
    ['centrale-chefchaouen', 'plant_manager'],
    ['comptable', 'accountant'],
    ['proprietaire', 'owner'],
    ['admin', 'app_admin'],
  ])('%s (%s)', (name, role) => {
    const nav = navLabels(role);
    // words that are buttons or notions of the page, not menu entries
    const notMenu = new Set([
      'Réaffecter',
      'Reporter',
      'Durées estimées',
      'Retards des 14 derniers jours',
      'Production',
      'Achats',
      'Ventes',
      'Trésorerie',
      'Administration',
      'À décider',
    ]);
    const unknown = named(card(name)).filter(
      (s) => !nav.includes(s) && !notMenu.has(s) && !(NOT_OWNED[name] ?? []).includes(s),
    );
    // Production/Achats/... as group names are allowed above; a single-name screen that the role does not have is a mistake.
    expect(unknown, `${name}: ${unknown.join(', ')}`).toEqual([]);
  });
  it('no card sends a trainee to the old "Répartition" or to the sales office\'s Devis / Commandes lists', () => {
    for (const name of ['ventes', 'achats', 'centrale-tetouan', 'centrale-chefchaouen', 'proprietaire'])
      expect(card(name)).not.toMatch(/\*Répartition\*/);
    expect(navLabels('office_sales')).not.toContain('Devis');
    expect(navLabels('office_sales')).not.toContain('Commandes');
    // and the exercises of the sales card never send a trainee to them (they are only named as screens the role does not have)
    expect(card('ventes')).not.toMatch(/(ouvre|dans|vers) \*(Devis|Commandes)\*/);
  });
});
