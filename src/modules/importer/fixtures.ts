import { buildWorkbook } from './domain/xlsx-writer';

// Synthetic workbooks for the import tests and for rehearsals. EVERYTHING in them is invented and says so: names with FICTIF, ICE
// starting 999000, phones 0600000xxx, banks "Banque Fictive". No real file, name or number is the source of any cell. The valid book
// uses the built-in sheet names and headers (the defaults); the problems book carries one known fault per line, listed in
// `expectedProblems`, so a test can check the exact row and sheet the report names.

type Cell = string | number;
type Rows = Cell[][];
export interface SyntheticOptions {
  /** Short upper-case prefix of the concrete type codes (default FK). Change it to import the book twice into one database. */
  prefix?: string;
  /** Two existing plant codes (2 to 8 letters). */
  plants?: [string, string];
  /**
   * The number of the first truck code (T<n>, T<n+1>, P<n>; default 1). A database that already has trucks with these codes and other
   * plates answers a CONFLICT (R14-08: it no longer skips them as "already there"), so a rehearsal into such a database picks free numbers.
   */
  truckNo?: number;
}

// 15 digits starting 999 (no real company has one); the next three digits come from the prefix, so two prefixes never share an ICE
const ice = (prefix: string, n: number) => {
  const salt = [...prefix].reduce((t, c) => (t * 31 + c.charCodeAt(0)) % 1000, 7);
  return `999${String(salt).padStart(3, '0')}${String(n).padStart(9, '0')}`;
};

function sheets(o: Required<SyntheticOptions>): Record<string, Rows> {
  const [pa, pb] = o.plants;
  const t = (n: number) => `${o.prefix}${n}`;
  return {
    Types: [
      ['Code', 'Libellé'],
      [t(20), 'Béton FICTIF 20'],
      [t(25), 'Béton FICTIF 25'],
      [t(30), 'Béton FICTIF 30'],
    ],
    Composants: [
      ['Nom', 'Nom AR', 'Unité', "Unité d'achat", 'Contenu'],
      [`Ciment FICTIF ${o.prefix}`, '', 'g', 'Sac 50 kg', 50000],
      [`Sable FICTIF ${o.prefix}`, '', 'g', '', ''],
      [`Gravette FICTIVE ${o.prefix}`, '', 'g', '', ''],
      [`Adjuvant FICTIF ${o.prefix}`, '', 'mL', '', ''],
    ],
    Recettes: [
      ['Type', 'Composant', 'Quantité', 'Unité', 'À partir du', 'Centrale'],
      [t(25), `Ciment FICTIF ${o.prefix}`, '350', 'kg', '01/01/2026', ''],
      [t(25), `Sable FICTIF ${o.prefix}`, '800', 'kg', '01/01/2026', ''],
      [t(25), `Gravette FICTIVE ${o.prefix}`, '1050', 'kg', '01/01/2026', ''],
      [t(25), `Adjuvant FICTIF ${o.prefix}`, '2,5', 'L', '01/01/2026', ''],
      [t(25), `Ciment FICTIF ${o.prefix}`, '340', 'kg', '01/03/2026', pa],
      [t(25), `Sable FICTIF ${o.prefix}`, '820', 'kg', '01/03/2026', pa],
    ],
    Clients: [
      ['Nom', 'Type', 'ICE', 'Téléphone', 'Délai de paiement'],
      [`CLIENT FICTIF 001 SARL ${o.prefix}`, 'société', ice(o.prefix, 1), '0000 00 0001', 60],
      [`CLIENT FICTIF 002 ${o.prefix}`, 'particulier', '', '0000 00 0002', ''],
      [`CLIENT FICTIF 003 SA ${o.prefix}`, 'société', ice(o.prefix, 3), '0000 00 0003', 90],
    ],
    Fournisseurs: [
      ['Nom', 'Catégorie', 'ICE', 'Téléphone'],
      [`FOURNISSEUR FICTIF CIMENT ${o.prefix}`, 'cement', ice(o.prefix, 11), '0000 00 0011'],
      [`FOURNISSEUR FICTIF SABLE ${o.prefix}`, 'aggregates', ice(o.prefix, 12), '0000 00 0012'],
    ],
    Camions: [
      ['Code', 'Immatriculation', 'Capacité', 'Type', 'Centrale'],
      [`T${o.truckNo}`, `FICTIF-${o.prefix}-1`, '8', 'malaxeur', pa],
      [`T${o.truckNo + 1}`, `FICTIF-${o.prefix}-2`, '8', 'malaxeur', pb],
    ],
    Pompes: [
      ['Code', 'Immatriculation'],
      [`P${o.truckNo}`, `FICTIF-${o.prefix}-P1`],
    ],
    Prix: [
      ['Type', 'Prix HT', 'À partir du', 'Centrale'],
      [t(25), '760', '01/01/2026', ''],
      [t(25), '775,00', '01/01/2026', pa],
      [t(25), '770,50', '01/01/2026', pb],
      [t(30), '820', '01/01/2026', ''],
    ],
    Soldes: [
      ['Tiers', 'Code', 'Montant', 'Référence'],
      ['client', `CLIENT FICTIF 001 SARL ${o.prefix}`, '15 000,00', 'Solde fictif'],
      ['fournisseur', `FOURNISSEUR FICTIF CIMENT ${o.prefix}`, '8 250,50', 'Solde fictif'],
    ],
    Cheques: [
      ['Client', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
      [
        `CLIENT FICTIF 001 SARL ${o.prefix}`,
        'chèque',
        `FICTIF-${o.prefix}-001`,
        'Banque Fictive',
        '12 500,00',
        '15/10/2026',
      ],
      [
        `CLIENT FICTIF 003 SA ${o.prefix}`,
        'LCN',
        `FICTIF-${o.prefix}-002`,
        'Banque Fictive',
        '8000',
        '20/10/2026',
      ],
    ],
    Facture: [
      ['Année', 'Dernier numéro'],
      [2026, 137],
    ],
  };
}

/** One fault per line, in the sheets of the valid book: [sheet, row number, a phrase the report must contain]. */
export const EXPECTED_PROBLEMS: readonly (readonly [string, number, string])[] = [
  ['Clients', 3, 'invalid row'],
  ['Clients', 4, 'twice in the file'],
  ['Camions', 2, 'capacity'],
  ['Prix', 2, 'ambiguous amount'],
  ['Prix', 3, 'date not understood or ambiguous'],
  ['Prix', 4, 'unknown concrete type'],
  ['Soldes', 2, 'negative'],
  ['Soldes', 3, 'unknown client or supplier'],
  ['Cheques', 2, 'more than two decimals'],
  ['Facture', 2, 'year'],
];

function problemSheets(o: Required<SyntheticOptions>): Record<string, Rows> {
  const ok = sheets(o);
  const t = (n: number) => `${o.prefix}${n}`;
  return {
    ...ok,
    Clients: [
      ['Nom', 'Type', 'ICE', 'Téléphone'],
      [`CLIENT FICTIF 001 SARL ${o.prefix}`, 'société', ice(o.prefix, 1), '0000 00 0001'],
      [`CLIENT FICTIF 004 SARL ${o.prefix}`, 'société', '123', '0000 00 0004'],
      [`CLIENT FICTIF 001 SARL ${o.prefix}`, 'société', ice(o.prefix, 5), '0000 00 0005'],
    ],
    Camions: [
      ['Code', 'Immatriculation', 'Capacité', 'Type'],
      [`T${o.truckNo}`, `FICTIF-${o.prefix}-1`, '99', 'malaxeur'],
    ],
    Prix: [
      ['Type', 'Prix HT', 'À partir du'],
      [t(25), '1,234', '01/01/2026'],
      [t(25), '760', '31/02/2026'],
      ['ZZZZ', '760', '01/01/2026'],
    ],
    Soldes: [
      ['Tiers', 'Code', 'Montant'],
      ['client', `CLIENT FICTIF 001 SARL ${o.prefix}`, '-50'],
      ['client', 'PERSONNE FICTIVE INCONNUE', '100'],
    ],
    Cheques: [
      ['Client', 'Type', 'Numéro', 'Banque', 'Montant', 'Date'],
      [
        `CLIENT FICTIF 001 SARL ${o.prefix}`,
        'chèque',
        `FICTIF-${o.prefix}-009`,
        'Banque Fictive',
        '1 234,567',
        '15/10/2026',
      ],
    ],
    Facture: [
      ['Année', 'Dernier numéro'],
      [1999, 5],
    ],
  };
}

const book = (s: Record<string, Rows>) =>
  buildWorkbook(Object.entries(s).map(([name, rows]) => ({ name, rows })));
const withDefaults = (o: SyntheticOptions): Required<SyntheticOptions> => ({
  prefix: o.prefix ?? 'FK',
  plants: o.plants ?? ['FAKEONE', 'FAKETWO'],
  truckNo: o.truckNo ?? 1,
});

/** A complete, valid book with every sheet. */
export const syntheticValidWorkbook = (o: SyntheticOptions = {}): Buffer => book(sheets(withDefaults(o)));
/** The same book with the faults listed in EXPECTED_PROBLEMS. */
export const syntheticProblemWorkbook = (o: SyntheticOptions = {}): Buffer =>
  book(problemSheets(withDefaults(o)));
