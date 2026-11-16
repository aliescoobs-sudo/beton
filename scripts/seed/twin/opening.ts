// T20 item 5: the opening position as it would be loaded for 30 Nov 2026 (D246), through the REAL importer kinds (`runImport`, the code behind `import:excel`): per-invoice open
// items for clients and suppliers (older invoices, so they fill the 61-90 and 90+ buckets), one client and one supplier with the single "aging unknown" line, a loan and a
// leasing with their instalment schedule, and the opening stock of three small components counted on 30 Nov (the main components already have the stock of the history period).
// Each sheet is built in memory by the importer's own workbook writer, read back by its own reader, dry-run first, then applied; the second run of the same sheet changes nothing.
// What the full workbook path adds (the typed phrase and a fresh second factor of the owner) is a human step the seed cannot and must not stand in for.
import { readSheet } from '../../../src/modules/importer/index.ts';
import { buildXlsx } from '../../../src/modules/importer/domain/xlsx-writer.ts';
import { formatReport, runImport, type ImportKind } from '../../../src/modules/importer/service/importers.ts';
import { createComponent, listComponents } from '../../../src/modules/master-data/index.ts';
import { enterOpeningDate } from '../../../src/modules/ledger/index.ts';
import { type TwinContext, TwinSeedError, addDays, must } from './context.ts';
import { TWIN_OPENING_DATE } from './guard.ts';
import type { World } from './structure.ts';

export interface OpeningResult {
  sheets: Record<string, { created: number; exists: number }>;
  openItems: number;
  obligationRows: number;
}

const dmy = (iso: string): string => `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mad = (centimes: number): string =>
  `${String(Math.floor(centimes / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(centimes % 100).padStart(2, '0')}`;

/** Clients with old, unpaid invoices (a mix of the slow, late and bad payers), and the suppliers we still owe from before. */
const CLIENT_ITEM_PARTIES = [
  'Société Jbel Dersa Terrassement (fictif)',
  'rif habitat promotion (fictif)',
  'Bennani TP (fictif)',
  'el idrissi et fils (fictif)',
  'Immo Khmiss Construction (fictif)',
  'sarl andalous bâtiment (fictif)',
  'HABITAT MARTIL COOP (fictif)',
  'Commune Rurale Bab Taza (fictif)',
];
const CLIENT_SINGLE_LINE = 'Coopérative Ketama Équipement (fictif)';
const SUPPLIER_ITEM_PARTIES = [
  'Ciments Atlas Rif (fictif)',
  'Transports Rifains (fictif)',
  'Chimie Béton Nord (fictif)',
];
const SUPPLIER_SINGLE_LINE = 'Pièces Mixer Nord (fictif)';

export async function buildOpening(ctx: TwinContext, world: World): Promise<OpeningResult> {
  const { app } = ctx.pools;
  const { owner, anchor, rng } = ctx;
  const result: OpeningResult = { sheets: {}, openItems: 0, obligationRows: 0 };
  must('opening date', await enterOpeningDate(app, owner, { openingDate: TWIN_OPENING_DATE }));
  const importCtx = { appPool: app, actor: owner, openingDate: TWIN_OPENING_DATE, today: anchor };

  const load = async (kind: ImportKind, rows: (string | number)[][]) => {
    const sheet = readSheet(buildXlsx(rows));
    const dry = await runImport(kind, sheet, { ...importCtx, apply: false });
    if (dry.missingColumns.length || dry.counts.error)
      throw new TwinSeedError(
        `twin seed: the ${kind} sheet is refused by the importer's dry run:\n${formatReport(dry)}`,
      );
    const done = await runImport(kind, sheet, { ...importCtx, apply: true });
    if (done.counts.failed)
      throw new TwinSeedError(`twin seed: the ${kind} sheet failed to apply:\n${formatReport(done)}`);
    result.sheets[kind] = { created: done.counts.created, exists: done.counts.exists };
  };

  // Per-invoice open items. The due dates are chosen against the anchor so that every bucket from "1-30 days late" to "90+" holds something.
  const dueAgo = [128, 112, 96, 84, 77, 70, 64, 52, 45, 39, 33, 26, 18, 9];
  const clientRows: (string | number)[][] = [
    ['Tiers', 'Code', 'Facture', 'Date facture', 'Échéance', 'Montant facture', 'Reste'],
  ];
  let n = 0;
  for (const [i, name] of CLIENT_ITEM_PARTIES.entries()) {
    const client = world.clients.find((c) => c.spec.name === name);
    if (!client) throw new TwinSeedError(`twin seed: unknown client ${name}`);
    const items = i % 3 === 0 ? 3 : 2;
    for (let k = 0; k < items; k++) {
      n += 1;
      const due = addDays(anchor, -dueAgo[(i * 2 + k * 3) % dueAgo.length]!);
      const invoice = addDays(due, -client.spec.terms || -30);
      const amount = rng.int(900_000, 14_000_000);
      const rest = k === 0 && i % 2 === 0 ? Math.round(amount * (rng.int(40, 85) / 100)) : amount;
      clientRows.push([
        'client',
        client.code,
        `ANC-26-${String(1000 + n)}`,
        dmy(invoice),
        dmy(due),
        mad(amount),
        mad(rest),
      ]);
      result.openItems += 1;
    }
  }
  const supplierRows: (string | number)[][] = [];
  for (const [i, name] of SUPPLIER_ITEM_PARTIES.entries()) {
    const supplier = world.suppliers.find((s) => s.name === name);
    if (!supplier) throw new TwinSeedError(`twin seed: unknown supplier ${name}`);
    for (let k = 0; k < 2; k++) {
      n += 1;
      const due = addDays(anchor, -dueAgo[(i * 5 + k * 4 + 1) % dueAgo.length]!);
      const amount = rng.int(1_200_000, 9_000_000);
      supplierRows.push([
        'fournisseur',
        supplier.code,
        `FF-ANC-${String(500 + n)}`,
        dmy(addDays(due, -30)),
        dmy(due),
        mad(amount),
        mad(amount),
      ]);
      result.openItems += 1;
    }
  }
  await load('open_items', [...clientRows, ...supplierRows]);

  // One client and one supplier known only by their single line (the age of the debt is unknown: it shows as "due date unknown" on the aging screen).
  const single = world.clients.find((c) => c.spec.name === CLIENT_SINGLE_LINE)!;
  const singleSupplier = world.suppliers.find((s) => s.name === SUPPLIER_SINGLE_LINE)!;
  await load('opening_balances', [
    ['Tiers', 'Code', 'Montant', 'Référence'],
    ['client', single.code, '76 500,00', 'Solde repris, ancienneté inconnue (fictif)'],
    ['fournisseur', singleSupplier.code, '18 240,00', 'Solde repris, ancienneté inconnue (fictif)'],
  ]);

  // A loan and a leasing, with the instalments still to pay at the opening date.
  const instalments: (string | number)[][] = [['Contrat', 'Type', 'Organisme', 'Échéance', 'Montant']];
  for (let k = 0; k < 12; k++)
    instalments.push([
      'PRET-INV-01',
      'prêt',
      'Banque Atlas (fictive)',
      dmy(addDays('2026-12-05', 30 * k + Math.floor(k / 2))),
      '38 500,00',
    ]);
  for (let k = 0; k < 18; k++)
    instalments.push([
      'LEASING-MX-02',
      'leasing',
      'Société de leasing du Nord (fictive)',
      dmy(addDays('2026-12-10', 30 * k + Math.floor(k / 2))),
      '21 250,00',
    ]);
  result.obligationRows = instalments.length - 1;
  await load('obligations', instalments);

  // Opening stock: three small components counted on 30 Nov in both plants. The components are created here (the master data does not have them).
  const extra = [
    {
      nameFr: 'Retardateur de prise (fictif)',
      nameAr: 'مؤخر التصلب (وهمي)',
      baseUnit: 'mL' as const,
      unit: 'L',
      qty: [180, 95],
    },
    {
      nameFr: 'Fibres polypropylène (fictif)',
      nameAr: 'ألياف (وهمي)',
      baseUnit: 'g' as const,
      unit: 'kg',
      qty: [95, 60],
    },
    {
      nameFr: 'Colorant gris (fictif)',
      nameAr: 'ملون رمادي (وهمي)',
      baseUnit: 'g' as const,
      unit: 'kg',
      qty: [40, 25],
    },
  ];
  const have = new Set((await listComponents(app, owner)).map((c) => c.nameFr));
  for (const c of extra)
    if (!have.has(c.nameFr))
      must(
        `component ${c.nameFr}`,
        await createComponent(app, owner, { nameFr: c.nameFr, nameAr: c.nameAr, baseUnit: c.baseUnit }),
      );
  const stockRows: (string | number)[][] = [['Centrale', 'Composant', 'Quantité', 'Unité']];
  for (const c of extra) {
    stockRows.push([ctx.plants.TET.code, c.nameFr, c.qty[0]!, c.unit]);
    stockRows.push([ctx.plants.CHF.code, c.nameFr, c.qty[1]!, c.unit]);
  }
  await load('opening_stock', stockRows);
  return result;
}
