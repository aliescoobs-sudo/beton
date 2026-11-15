import type pg from 'pg';
import { realClock } from '@/modules/clock';
import {
  createClient,
  createComponent,
  createConcreteType,
  createListPrice,
  createPurchaseUnit,
  createRecetteVersion,
  createSupplier,
  createTruck,
  listClients,
  listComponents,
  listPurchaseUnits,
  listConcreteTypes,
  listPlants,
  listRecetteVersions,
  listSellingPrices,
  listSuppliers,
  listTrucks,
  BASE_UNITS,
  parseCapacityM3,
  parseClientInput,
  parseEntryQty,
  defaultEntryUnit,
  parseComponentInput,
  parseConcreteTypeInput,
  parseTruckInput,
  SUPPLIER_CATEGORIES,
} from '@/modules/master-data';
import {
  addPartyOpeningBalance,
  enterOpeningDate,
  COUNTER_PREFIXES,
  getDocCounter,
  getInvoiceSequence,
  getOpeningState,
  issueInstrument,
  listClientAliases,
  listInstruments,
  listMoneyAccounts,
  receiveInstrument,
  setDocCounter,
  setInvoiceSequence,
  setOpeningBalance,
  type CounterPrefix,
} from '@/modules/ledger';
import type { SessionUser } from '@/modules/platform-security';
import { type DateFormat, type Sheet, toIsoDate, toRecords } from '../domain/sheet';
import { parseImportAmount, parseWholeNumber } from '../domain/values';

/**
 * R15B-09: a name or a code that belongs to SEVERAL records identifies none of them. The importers used a Map keyed by name, where the last
 * duplicate silently won, so money could be attached to the wrong party. Returns the lowercase keys shared by two or more different records;
 * a row that uses one is refused with a message that asks for the code.
 */
export function ambiguousKeys<T extends { id: string }>(
  items: T[],
  keysOf: (item: T) => string[],
): Set<string> {
  const owner = new Map<string, string>();
  const shared = new Set<string>();
  for (const item of items) {
    for (const key of new Set(keysOf(item))) {
      const first = owner.get(key);
      if (first !== undefined && first !== item.id) shared.add(key);
      else owner.set(key, item.id);
    }
  }
  return shared;
}
const AMBIGUOUS = 'several records have this name or code: identify it by its unique code';

// Excel importers (REQUIREMENTS-V1 §14). Every row goes through the same parser and the same service as the screen, so the same
// rules, row-level security and audit apply. A DRY RUN (the default) validates every row, looks for what exists already, writes
// nothing, and says what a real run would do. A real run only starts when the dry run found no error, and re-running is safe:
// what exists is skipped, never doubled.

export const IMPORT_KINDS = [
  'concrete_types',
  'clients',
  'suppliers',
  'trucks',
  'pumps',
  'selling_prices',
  'opening_balances',
  'cheques_in_transit',
  'components',
  'recipes',
  'invoice_sequence',
  // T19 item 3 (D246): the rest of the opening position at 30 Nov
  'doc_counters',
  'account_balances',
  'cheques_issued',
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export interface ImportRow {
  row: number;
  status: 'new' | 'exists' | 'error' | 'created' | 'failed';
  label: string;
  message?: string;
}
export interface ImportReport {
  kind: ImportKind;
  dryRun: boolean;
  rows: ImportRow[];
  /** A missing column makes the whole file unusable: nothing is read further. */
  missingColumns: string[];
  counts: { new: number; exists: number; error: number; created: number; failed: number };
  /**
   * D246 totals control, before anything is written: rows read, rows that would be written, and (for a sheet of amounts) the MAD sum of the file
   * and of the rows that would be written, in centimes. The operator compares them with the Excel closing figures; nothing but counts and sums is kept.
   */
  totals: { rows: number; writable: number; fileCentimes: number | null; writableCentimes: number | null };
}

interface Planned {
  row: number;
  label: string;
  error?: string;
  exists?: boolean;
  apply?: () => Promise<string | null>;
}
export interface Ctx {
  appPool: pg.Pool;
  actor: SessionUser;
  /** The header names accepted per field when the sheet's mapping file gives them (default: COLUMNS of the kind). */
  columns?: Record<string, readonly string[]>;
  /** 1-based row of the headers (default 1). */
  headerRow?: number;
  /** The order of a text date (default 'dmy'). */
  dateFormat?: DateFormat;
  /** See `runImport`: apply the valid rows of a sheet that has problems too (the caller discards everything). */
  applyValidRows?: boolean;
  /** The plant code used when a row has no plant of its own (prices, recipes, trucks). */
  defaultPlant?: string;
  openingDate?: string;
  /** The business date the instruments are received on (default: today). */
  today?: string;
}

export const COLUMNS = {
  concrete_types: {
    code: ['code', 'type', 'classe'],
    label: ['label', 'libelle', 'désignation', 'designation', 'nom'],
  },
  clients: {
    name: ['name', 'nom', 'raison sociale', 'client'],
    kind: ['kind', 'type', 'nature'],
    ice: ['ice'],
    phone: ['phone', 'tel', 'telephone', 'téléphone', 'gsm'],
    contact: ['contact', 'contact name', 'nom du contact'],
    terms: ['terms', 'payment terms', 'delai paiement', 'délai de paiement', 'delai'],
    notes: ['notes', 'remarques', 'observations'],
  },
  suppliers: {
    name: ['name', 'nom', 'raison sociale', 'fournisseur'],
    category: ['category', 'categorie', 'catégorie'],
    ice: ['ice'],
    phone: ['phone', 'tel', 'telephone', 'téléphone', 'gsm'],
    terms: ['terms', 'payment terms', 'delai paiement', 'délai de paiement', 'delai'],
    lead: ['lead', 'lead time', 'delai livraison', 'délai de livraison'],
  },
  trucks: {
    code: ['code', 'camion'],
    plate: ['plate', 'immatriculation', 'matricule'],
    capacity: ['capacity', 'capacite', 'capacité', 'm3', 'capacite m3'],
    kind: ['kind', 'type', 'genre'],
    plant: ['plant', 'centrale', 'site'],
  },
  // Pump trucks: the same columns as the trucks; the kind is always "pump" and its code P1, P2...
  pumps: {
    code: ['code', 'pompe', 'camion'],
    plate: ['plate', 'immatriculation', 'matricule'],
    capacity: ['capacity', 'capacite', 'capacité', 'm3', 'capacite m3'],
    plant: ['plant', 'centrale', 'site'],
  },
  // The reference (list) price per m³ HT of a concrete type from a date; with a plant it is that plant's price, without it the price of all.
  selling_prices: {
    type: ['type', 'code', 'classe', 'beton'],
    price: ['price', 'prix', 'prix ht', 'prix m3'],
    from: ['from', 'date', 'a partir du', 'à partir du', 'effective'],
    plant: ['plant', 'centrale', 'site'],
  },
  opening_balances: {
    party: ['party', 'tiers', 'type tiers'],
    code: ['code', 'code tiers'],
    amount: ['amount', 'montant', 'solde'],
    reference: ['reference', 'référence', 'ref'],
  },
  // Cheques and LCN received and not yet deposited or cleared (C3). Each becomes an instrument in the state "received".
  cheques_in_transit: {
    client: ['client', 'code client', 'tiers', 'code'],
    method: ['method', 'type', 'mode', 'nature'],
    number: ['number', 'numero', 'numéro', 'n°', 'no', 'numero cheque', 'numéro chèque'],
    bank: ['bank', 'banque'],
    amount: ['amount', 'montant'],
    written: ['written', 'date', 'date cheque', 'date chèque', 'date ecriture', 'date écrite', 'date lcn'],
  },
  // A component and, when given, the purchase unit it is bought in (e.g. "sac 50 kg" = 50000 g).
  components: {
    nameFr: ['name', 'nom', 'nom fr', 'name fr', 'designation', 'désignation', 'composant'],
    nameAr: ['name ar', 'nom ar', 'arabe', 'الاسم'],
    unit: ['unit', 'unite', 'unité', 'base unit', 'unite de base', 'unité de base'],
    purchaseUnit: ['purchase unit', 'unite achat', 'unité achat', 'unité d achat', 'conditionnement'],
    factor: ['factor', 'facteur', 'contenu', 'quantite par unite', 'quantité par unité'],
  },
  // One line of a recipe per row; rows with the same type and date are one version.
  recipes: {
    type: ['type', 'beton', 'béton', 'classe', 'code type'],
    component: ['component', 'composant', 'code composant', 'matiere', 'matière'],
    qty: ['qty', 'quantity', 'quantite', 'quantité', 'dosage', 'par m3', 'qte'],
    unit: ['unit', 'unite', 'unité'],
    from: ['from', 'date', 'a partir du', 'à partir du', 'effective'],
    plant: ['plant', 'centrale', 'site'],
  },
  // The last invoice number of the year already issued on paper: the next invoice is last + 1.
  invoice_sequence: {
    year: ['year', 'annee', 'année', 'exercice'],
    last: ['last', 'dernier numero', 'dernier numéro', 'dernier numero de facture', 'numero', 'numéro'],
  },
  // The last number of each paper or Excel series (CMD, BL, ACH, FA): the next document is last + 1 (forward only).
  doc_counters: {
    prefix: ['prefix', 'prefixe', 'préfixe', 'serie', 'série', 'type'],
    year: ['year', 'annee', 'année', 'exercice'],
    last: ['last', 'dernier numero', 'dernier numéro', 'numero', 'numéro'],
  },
  // The opening balance of a cash or bank account (by its label) on the opening date.
  account_balances: {
    account: ['account', 'compte', 'caisse', 'banque', 'label', 'libelle', 'libellé'],
    asOf: ['as of', 'date', 'au', 'date solde'],
    amount: ['amount', 'montant', 'solde'],
    note: ['note', 'remarque', 'commentaire'],
  },
  // Cheques and LCN we ISSUED and that are not cleared yet (outstanding): supplier, number, bank, amount, written (due) date.
  cheques_issued: {
    supplier: ['supplier', 'fournisseur', 'code fournisseur', 'tiers', 'code'],
    method: ['method', 'type', 'mode', 'nature'],
    number: ['number', 'numero', 'numéro', 'n°', 'no', 'numero cheque', 'numéro chèque'],
    bank: ['bank', 'banque'],
    amount: ['amount', 'montant'],
    written: ['written', 'date', 'echeance', 'échéance', 'date cheque', 'date chèque', 'date lcn'],
  },
} as const satisfies Record<ImportKind, Record<string, readonly string[]>>;

/** A record with every column of its kind present (an empty cell is ''), so a field is a string, never undefined. */
const full = <K extends ImportKind>(
  kind: K,
  values: Record<string, string>,
): Record<keyof (typeof COLUMNS)[K], string> =>
  Object.fromEntries(Object.keys(COLUMNS[kind]).map((k) => [k, values[k] ?? ''])) as Record<
    keyof (typeof COLUMNS)[K],
    string
  >;

/** The fields without which a sheet is unusable (the other columns are optional). */
export const REQUIRED_FIELDS: Record<ImportKind, string[]> = {
  concrete_types: ['code', 'label'],
  clients: ['name', 'kind'],
  suppliers: ['name', 'category'],
  trucks: ['code', 'plate'],
  pumps: ['code', 'plate'],
  selling_prices: ['type', 'price', 'from'],
  opening_balances: ['party', 'code', 'amount'],
  cheques_in_transit: ['client', 'method', 'number', 'amount', 'written'],
  components: ['nameFr', 'unit'],
  recipes: ['type', 'component', 'qty', 'from'],
  invoice_sequence: ['year', 'last'],
  doc_counters: ['prefix', 'year', 'last'],
  account_balances: ['account', 'asOf', 'amount'],
  cheques_issued: ['supplier', 'method', 'number', 'amount', 'written'],
};

const KIND_ALIASES: Record<string, string> = {
  company: 'company',
  societe: 'company',
  société: 'company',
  entreprise: 'company',
  sarl: 'company',
  person: 'person',
  particulier: 'person',
  personne: 'person',
  mixer: 'mixer',
  malaxeur: 'mixer',
  toupie: 'mixer',
  camion: 'mixer',
  pump: 'pump',
  pompe: 'pump',
  external: 'external',
  externe: 'external',
  loué: 'external',
  loue: 'external',
  client: 'client',
  fournisseur: 'supplier',
  supplier: 'supplier',
};
const alias = (v: string) => KIND_ALIASES[v.trim().toLowerCase()] ?? v.trim().toLowerCase();
const num = (v: string): number | undefined => (v === '' ? undefined : Number(v.replace(',', '.')));
const nul = (v: string) => (v === '' ? undefined : v);
const fail = (f: unknown): string => String((f as { error?: string }).error ?? 'refused');

async function plan(
  kind: ImportKind,
  sheet: Sheet,
  ctx: Ctx,
): Promise<{ planned: Planned[]; missing: string[]; amounts?: Map<number, number> }> {
  const {
    records: rawRecords,
    missing,
    ambiguous,
  } = toRecords(sheet, ctx.columns ?? COLUMNS[kind], ctx.headerRow ?? 1);
  // R14-04: two columns with an accepted header for one field: nothing is read (which one is meant is never guessed)
  if (ambiguous.length)
    return { planned: [], missing: ambiguous.map((f) => `${f} (two columns have this header)`) };
  // the optional columns do not make a file unusable
  const realMissing = missing.filter((m) => REQUIRED_FIELDS[kind].includes(m));
  if (realMissing.length) return { planned: [], missing: realMissing };
  const { appPool, actor } = ctx;
  const planned: Planned[] = [];

  if (kind === 'concrete_types') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('concrete_types', r.values) }));
    const have = new Map((await listConcreteTypes(appPool, actor)).map((t) => [t.code, t]));
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const input = { code: v.code, label: v.label };
      const parsed = parseConcreteTypeInput(input);
      if (!parsed.ok) planned.push({ row, label: v.code, error: 'invalid code or label' });
      else if (have.has(parsed.value.code)) {
        const d = differences([['label', parsed.value.label, have.get(parsed.value.code)?.label]]);
        planned.push(
          d.length
            ? { row, label: parsed.value.code, error: conflictMessage(d) }
            : { row, label: parsed.value.code, exists: true },
        );
      } else if (seen.has(parsed.value.code))
        planned.push({ row, label: parsed.value.code, error: 'twice in the file' });
      else {
        seen.add(parsed.value.code);
        planned.push({
          row,
          label: parsed.value.code,
          apply: async () => {
            const r = await createConcreteType(appPool, actor, input);
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  } else if (kind === 'clients') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('clients', r.values) }));
    const existing = await listClients(appPool, actor);
    const names = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));
    const ambNames = ambiguousKeys(existing, (c) => [c.name.trim().toLowerCase()]);
    const ices = new Set(existing.flatMap((c) => (c.ice ? [c.ice] : [])));
    const seenN = new Set<string>();
    const seenI = new Set<string>();
    for (const { row, values: v } of records) {
      const input = {
        name: v.name,
        kind: alias(v.kind),
        ice: nul(v.ice),
        phone: nul(v.phone),
        contactName: nul(v.contact),
        paymentTermsDays: num(v.terms),
        notes: nul(v.notes),
      };
      const parsed = parseClientInput(input);
      const key = v.name.trim().toLowerCase();
      if (!parsed.ok)
        planned.push({
          row,
          label: v.name,
          error: 'invalid row (name, type company/person, ICE 15 digits for a company, terms in days)',
        });
      else if (ambNames.has(key)) planned.push({ row, label: v.name, error: AMBIGUOUS });
      else if (names.has(key)) {
        const e = names.get(key)!;
        const d = differences([
          ['type', parsed.value.kind, e.kind],
          ['ICE', parsed.value.ice, e.ice],
          ['phone', parsed.value.phone, e.phone],
          ['contact', parsed.value.contactName, e.contactName],
          ['payment terms', v.terms === '' ? null : parsed.value.paymentTermsDays, e.paymentTermsDays],
          ['notes', parsed.value.notes, e.notes],
        ]);
        planned.push(
          d.length ? { row, label: v.name, error: conflictMessage(d) } : { row, label: v.name, exists: true },
        );
      } else if (seenN.has(key)) planned.push({ row, label: v.name, error: 'twice in the file' });
      else if (parsed.value.ice && (ices.has(parsed.value.ice) || seenI.has(parsed.value.ice)))
        planned.push({ row, label: v.name, error: 'this ICE belongs to another client' });
      else {
        seenN.add(key);
        if (parsed.value.ice) seenI.add(parsed.value.ice);
        planned.push({
          row,
          label: v.name,
          apply: async () => {
            const r = await createClient(appPool, actor, input);
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  } else if (kind === 'suppliers') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('suppliers', r.values) }));
    const existing = await listSuppliers(appPool, actor);
    const names = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s]));
    const ambNames = ambiguousKeys(existing, (s) => [s.name.trim().toLowerCase()]);
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const category = v.category.trim().toLowerCase();
      const input = {
        name: v.name,
        category,
        ice: nul(v.ice),
        phone: nul(v.phone),
        paymentTermsDays: num(v.terms),
        leadTimeDays: num(v.lead),
      };
      const key = v.name.trim().toLowerCase();
      if (!v.name.trim() || !(SUPPLIER_CATEGORIES as readonly string[]).includes(category)) {
        planned.push({
          row,
          label: v.name,
          error: `category must be one of ${SUPPLIER_CATEGORIES.join(', ')}`,
        });
      } else if (ambNames.has(key)) {
        planned.push({ row, label: v.name, error: AMBIGUOUS });
      } else if (names.has(key)) {
        const e = names.get(key)!;
        const d = differences([
          ['category', category, e.category],
          ['ICE', input.ice, e.ice],
          ['phone', input.phone, e.phone],
          ['payment terms', input.paymentTermsDays, e.paymentTermsDays],
          ['lead time', input.leadTimeDays, e.leadTimeDays],
        ]);
        planned.push(
          d.length ? { row, label: v.name, error: conflictMessage(d) } : { row, label: v.name, exists: true },
        );
      } else if (seen.has(key)) planned.push({ row, label: v.name, error: 'twice in the file' });
      else {
        seen.add(key);
        planned.push({
          row,
          label: v.name,
          apply: async () => {
            const r = await createSupplier(appPool, actor, input);
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  } else if (kind === 'trucks' || kind === 'pumps') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full(kind, r.values) }));
    const haveByKey = new Map<string, Awaited<ReturnType<typeof listTrucks>>[number]>();
    for (const t of await listTrucks(appPool, actor)) {
      haveByKey.set(t.code, t);
      haveByKey.set(t.plate.toUpperCase(), t);
    }
    const have = { has: (k: string) => haveByKey.has(k) };
    const plants = new Map(
      (await listPlants(appPool, actor)).filter((p) => p.status === 'active').map((p) => [p.code, p.id]),
    );
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const kindV = kind === 'pumps' ? 'pump' : 'kind' in v && v.kind ? alias(v.kind as string) : 'mixer';
      const cap = v.capacity ? parseCapacityM3(v.capacity) : null;
      const plantCode = (v.plant || ctx.defaultPlant || '').trim().toUpperCase();
      const plantId = plantCode ? (plants.get(plantCode) ?? 'unknown') : null;
      if (plantId === 'unknown') {
        planned.push({ row, label: v.code, error: 'unknown plant code' });
        continue;
      }
      const input = {
        code: v.code,
        plate: v.plate,
        ...(cap && cap.ok ? { capacityL: cap.value } : {}),
        kind: kindV,
        plantId,
      };
      const parsed = parseTruckInput(input);
      const plate = v.plate.trim().toUpperCase().replace(/\s+/g, ' ');
      if (v.capacity && cap && !cap.ok)
        planned.push({ row, label: v.code, error: 'capacity in m³ between 1 and 30' });
      else if (!parsed.ok)
        planned.push({ row, label: v.code, error: 'invalid code (T1, P1, X1 by kind), plate or kind' });
      else if (have.has(parsed.value.code) || have.has(plate)) {
        const e = haveByKey.get(parsed.value.code) ?? haveByKey.get(plate)!;
        const d = differences([
          ['code', parsed.value.code, e.code],
          ['plate', plate, e.plate.toUpperCase().replace(/\s+/g, ' ')],
          ['kind', parsed.value.kind, e.kind],
          ['capacity', cap && cap.ok ? cap.value : null, e.capacityL],
          ['plant', plantId, e.plantId],
        ]);
        planned.push(
          d.length ? { row, label: v.code, error: conflictMessage(d) } : { row, label: v.code, exists: true },
        );
      } else if (seen.has(parsed.value.code) || seen.has(plate))
        planned.push({ row, label: v.code, error: 'twice in the file' });
      else {
        seen.add(parsed.value.code);
        seen.add(plate);
        planned.push({
          row,
          label: v.code,
          apply: async () => {
            const r = await createTruck(appPool, actor, input);
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  } else if (kind === 'selling_prices') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('selling_prices', r.values) }));
    const types = new Map((await listConcreteTypes(appPool, actor)).map((t) => [t.code, t.id]));
    const plants = new Map(
      (await listPlants(appPool, actor)).filter((p) => p.status === 'active').map((p) => [p.code, p.id]),
    );
    const existing = (await listSellingPrices(appPool, actor)).filter((p) => p.clientId === null);
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const typeId = types.get(v.type.trim().toUpperCase());
      const amount = parseImportAmount(v.price);
      const from = toIsoDate(v.from, ctx.dateFormat);
      const plantCode = (v.plant || ctx.defaultPlant || '').trim().toUpperCase();
      const plantId = plantCode ? (plants.get(plantCode) ?? 'unknown') : null;
      const label = `${v.type} ${plantCode || 'all plants'} ${v.from}`;
      const key = `${typeId}|${plantId}|${from}`;
      if (!typeId) planned.push({ row, label, error: 'unknown concrete type (import the types first)' });
      else if (plantId === 'unknown') planned.push({ row, label, error: 'unknown plant code' });
      else if (!amount.ok || amount.value <= 0)
        planned.push({
          row,
          label,
          error: `price in MAD HT per m³: ${amount.ok ? 'must be above zero' : amount.reason}`,
        });
      else if (!from)
        planned.push({
          row,
          label,
          error: `date not understood or ambiguous (expected ${ctx.dateFormat ?? 'dmy'})`,
        });
      else if (
        existing.some((p) => p.concreteTypeId === typeId && p.plantId === plantId && p.effectiveFrom === from)
      ) {
        const e = existing.find(
          (p) => p.concreteTypeId === typeId && p.plantId === plantId && p.effectiveFrom === from,
        )!;
        const d = differences([['price', amount.value, e.priceHtPerM3Centimes]]);
        planned.push(d.length ? { row, label, error: conflictMessage(d) } : { row, label, exists: true });
      } else if (seen.has(key)) planned.push({ row, label, error: 'twice in the file' });
      else {
        seen.add(key);
        planned.push({
          row,
          label,
          apply: async () => {
            const r = await createListPrice(appPool, actor, {
              concreteTypeId: typeId,
              priceHtPerM3Centimes: amount.value,
              effectiveFrom: from,
              ...(plantId ? { plantId } : {}),
            });
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  } else if (kind === 'components') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('components', r.values) }));
    const existing = await listComponents(appPool, actor);
    const names = new Map(existing.map((c) => [c.nameFr.trim().toLowerCase(), c]));
    const ambNames = ambiguousKeys(existing, (c) => [c.nameFr.trim().toLowerCase()]);
    const purchaseUnits = await listPurchaseUnits(appPool, actor);
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const unit = BASE_UNITS.find((u) => u.toLowerCase() === v.unit.trim().toLowerCase());
      const key = v.nameFr.trim().toLowerCase();
      const factor = v.factor ? Number(v.factor.replace(/\s/g, '').replace(',', '.')) : undefined;
      const input = { nameFr: v.nameFr, nameAr: nul(v.nameAr) ?? v.nameFr, baseUnit: unit };
      if (!v.nameFr.trim() || !unit || !parseComponentInput(input).ok)
        planned.push({ row, label: v.nameFr, error: `name and a base unit (${BASE_UNITS.join(', ')})` });
      else if ((v.purchaseUnit !== '') !== (v.factor !== ''))
        planned.push({ row, label: v.nameFr, error: 'purchase unit and its content go together' });
      else if (v.factor && (factor === undefined || !Number.isInteger(factor) || factor < 1))
        planned.push({
          row,
          label: v.nameFr,
          error: `content of the purchase unit: a whole number of ${unit}`,
        });
      else if (ambNames.has(key)) planned.push({ row, label: v.nameFr, error: AMBIGUOUS });
      else if (names.has(key)) {
        const e = names.get(key)!;
        const mine = purchaseUnits.filter((u) => u.componentId === e.id && u.status === 'active');
        const d = differences([
          ['Arabic name', nul(v.nameAr), e.nameAr],
          ['base unit', unit, e.baseUnit],
          [
            'purchase unit',
            v.purchaseUnit,
            mine.length === 1 ? mine[0]!.label : mine.length === 0 ? '' : '(several)',
          ],
          [
            'purchase unit content',
            v.factor === '' ? null : factor,
            mine.length === 1 ? mine[0]!.factorToBase : null,
          ],
        ]);
        planned.push(
          d.length
            ? { row, label: v.nameFr, error: conflictMessage(d) }
            : { row, label: v.nameFr, exists: true },
        );
      } else if (seen.has(key)) planned.push({ row, label: v.nameFr, error: 'twice in the file' });
      else {
        seen.add(key);
        planned.push({
          row,
          label: v.nameFr,
          apply: async () => {
            const made = await createComponent(appPool, actor, input);
            if (!made.ok) return fail(made);
            if (v.purchaseUnit) {
              const u = await createPurchaseUnit(appPool, actor, made.value.id, {
                label: v.purchaseUnit,
                factorToBase: factor,
              });
              if (!u.ok) return fail(u);
            }
            return null;
          },
        });
      }
    }
  } else if (kind === 'recipes') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('recipes', r.values) }));
    const types = new Map((await listConcreteTypes(appPool, actor)).map((t) => [t.code, t.id]));
    const plants = new Map(
      (await listPlants(appPool, actor)).filter((p) => p.status === 'active').map((p) => [p.code, p.id]),
    );
    const components = await listComponents(appPool, actor);
    const byRef = new Map<string, (typeof components)[number]>();
    for (const c of components) {
      byRef.set(c.code.toLowerCase(), c);
      byRef.set(c.nameFr.trim().toLowerCase(), c);
    }
    const ambRef = ambiguousKeys(components, (c) => [c.code.toLowerCase(), c.nameFr.trim().toLowerCase()]);
    // rows of one version: the same type and date
    type Line = { row: number; componentId: string; qtyPerM3: number };
    const groups = new Map<
      string,
      {
        row: number;
        type: string;
        typeId: string;
        plantId: string | null;
        plantCode: string;
        from: string;
        lines: Line[];
        bad: boolean;
      }
    >();
    for (const { row, values: v } of records) {
      const typeId = types.get(v.type.trim().toUpperCase());
      const from = toIsoDate(v.from, ctx.dateFormat);
      const comp = byRef.get(v.component.trim().toLowerCase());
      const plantCode = (v.plant || ctx.defaultPlant || '').trim().toUpperCase();
      const plantId = plantCode ? (plants.get(plantCode) ?? 'unknown') : null;
      const label = `${v.type} ${v.from} ${v.component}`;
      if (!typeId) {
        planned.push({ row, label, error: 'unknown concrete type (import the types first)' });
        continue;
      }
      if (plantId === 'unknown') {
        planned.push({ row, label, error: 'unknown plant code' });
        continue;
      }
      if (!from) {
        planned.push({
          row,
          label,
          error: `date not understood or ambiguous (expected ${ctx.dateFormat ?? 'dmy'})`,
        });
        continue;
      }
      if (ambRef.has(v.component.trim().toLowerCase())) {
        planned.push({ row, label, error: AMBIGUOUS });
        continue;
      }
      if (!comp) {
        planned.push({ row, label, error: 'unknown component (import the components first)' });
        continue;
      }
      const unit = v.unit.trim() || defaultEntryUnit(comp.baseUnit);
      const qty = parseEntryQty(v.qty, comp.baseUnit, unit);
      if (!qty.ok) {
        planned.push({
          row,
          label,
          error: `quantity per m³ (check the quantity and the unit columns): ${qty.error}`,
        });
        continue;
      }
      const key = `${typeId}|${plantId}|${from}`;
      const group = groups.get(key) ?? {
        row,
        type: v.type.trim().toUpperCase(),
        typeId,
        plantId,
        plantCode,
        from,
        lines: [],
        bad: false,
      };
      if (group.lines.some((l) => l.componentId === comp.id)) {
        planned.push({ row, label, error: 'the component is twice in this recipe' });
        group.bad = true;
      } else group.lines.push({ row, componentId: comp.id, qtyPerM3: qty.value });
      groups.set(key, group);
    }
    for (const g of groups.values()) {
      const label = `${g.type} ${g.plantCode || 'all plants'} from ${g.from} (${g.lines.length} lines)`;
      if (g.bad) continue; // the row error above already blocks the file
      const versions = (await listRecetteVersions(appPool, actor, g.typeId)).filter(
        (x) => (x.plantId ?? null) === g.plantId,
      );
      const same = versions.find((x) => x.effectiveFrom === g.from);
      if (same) {
        const mine = new Map(g.lines.map((l) => [l.componentId, l.qtyPerM3]));
        const theirs = new Map(same.lines.map((l) => [l.componentId, l.qtyPerM3]));
        const identical = mine.size === theirs.size && [...mine].every(([id, q]) => theirs.get(id) === q);
        planned.push(
          identical
            ? { row: g.row, label, exists: true }
            : { row: g.row, label, error: conflictMessage(['the lines of the recipe']) },
        );
      } else if (versions.some((x) => x.effectiveFrom > g.from))
        planned.push({
          row: g.row,
          label,
          error: 'a newer version exists: the date must follow the latest one',
        });
      else
        planned.push({
          row: g.row,
          label,
          apply: async () => {
            const r = await createRecetteVersion(appPool, actor, g.typeId, {
              effectiveFrom: g.from,
              ...(g.plantId ? { plantId: g.plantId } : {}),
              lines: g.lines.map((l) => ({ componentId: l.componentId, qtyPerM3: l.qtyPerM3 })),
            });
            return r.ok ? null : fail(r);
          },
        });
    }
    planned.sort((a, b) => a.row - b.row);
  } else if (kind === 'cheques_in_transit') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('cheques_in_transit', r.values) }));
    const clients = new Map<string, string>();
    const clientList = await listClients(appPool, actor);
    for (const c of clientList) {
      clients.set(c.code.toLowerCase(), c.id);
      clients.set(c.name.trim().toLowerCase(), c.id);
    }
    // T19 item 4: a client may also be named by one of its aliases (an alias is unique and never another client's name)
    for (const a of await listClientAliases(appPool, actor))
      clients.set(a.alias.trim().toLowerCase(), a.clientId);
    const ambClients = ambiguousKeys(clientList, (c) => [c.code.toLowerCase(), c.name.trim().toLowerCase()]);
    const haveByKey = new Map<string, Awaited<ReturnType<typeof listInstruments>>[number]>();
    for (const i of (await listInstruments(appPool, actor)).filter((x) => x.direction === 'in'))
      haveByKey.set(`${i.partyId}|${(i.number ?? '').toLowerCase()}|${(i.bank ?? '').toLowerCase()}`, i);
    const have = { has: (k: string) => haveByKey.has(k) };
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const clientId = clients.get(v.client.trim().toLowerCase());
      const method = ['cheque', 'chèque', 'check'].includes(v.method.trim().toLowerCase())
        ? 'cheque'
        : ['lcn', 'effet'].includes(v.method.trim().toLowerCase())
          ? 'lcn'
          : null;
      const amount = parseImportAmount(v.amount);
      const written = toIsoDate(v.written, ctx.dateFormat);
      const label = `${v.number} ${v.client}`;
      const key = `${clientId}|${v.number.toLowerCase()}|${v.bank.toLowerCase()}`;
      if (ambClients.has(v.client.trim().toLowerCase())) planned.push({ row, label, error: AMBIGUOUS });
      else if (!clientId) planned.push({ row, label, error: 'unknown client (code or exact name)' });
      else if (!method) planned.push({ row, label, error: 'type must be cheque or lcn' });
      else if (!v.number.trim()) planned.push({ row, label, error: 'the cheque or LCN number is required' });
      else if (!amount.ok || amount.value <= 0)
        planned.push({
          row,
          label,
          error: `amount in MAD: ${amount.ok ? 'must be above zero' : amount.reason}`,
        });
      else if (!written)
        planned.push({
          row,
          label,
          error: `date not understood or ambiguous (expected ${ctx.dateFormat ?? 'dmy'})`,
        });
      else if (have.has(key)) {
        const e = haveByKey.get(key)!;
        const d = differences([
          ['amount', amount.value, e.amountCentimes],
          ['type', method, e.method],
          ['written date', written, e.writtenDate],
        ]);
        planned.push(d.length ? { row, label, error: conflictMessage(d) } : { row, label, exists: true });
      } else if (seen.has(key)) planned.push({ row, label, error: 'twice in the file' });
      else {
        seen.add(key);
        planned.push({
          row,
          label,
          apply: async () => {
            const r = await receiveInstrument(
              appPool,
              actor,
              {
                clientId,
                method,
                amountCentimes: amount.value,
                number: v.number,
                bank: nul(v.bank),
                writtenDate: written,
              },
              { today: ctx.today ?? realClock.now().toISOString().slice(0, 10), source: 'opening_30_11' },
            );
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  } else if (kind === 'invoice_sequence') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('invoice_sequence', r.values) }));
    const seenYears = new Set<number>();
    for (const { row, values: v } of records) {
      const year = parseWholeNumber(v.year, 2000, 2999);
      const last = parseWholeNumber(v.last, 1, 99_999_999);
      const label = `${v.year}: ${v.last}`;
      if (!year.ok) planned.push({ row, label, error: `year: ${year.reason}` });
      else if (!last.ok) planned.push({ row, label, error: `last invoice number: ${last.reason}` });
      else if (seenYears.has(year.value)) planned.push({ row, label, error: 'this year twice in the file' });
      else {
        seenYears.add(year.value);
        const now = await getInvoiceSequence(appPool, actor, year.value);
        if (now !== null && now === last.value) planned.push({ row, label, exists: true });
        else if (now !== null && now > last.value)
          planned.push({
            row,
            label,
            error: `numbers up to ${now} are already issued: the sequence only moves forward`,
          });
        else
          planned.push({
            row,
            label,
            apply: async () => {
              const r = await setInvoiceSequence(appPool, actor, { year: year.value, last: last.value });
              return r.ok ? null : fail(r);
            },
          });
      }
    }
  } else if (kind === 'doc_counters') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('doc_counters', r.values) }));
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const prefix = v.prefix.trim().toUpperCase() as CounterPrefix;
      const year = parseWholeNumber(v.year, 2000, 2999);
      const last = parseWholeNumber(v.last, 1, 99_999_999);
      const label = `${v.prefix} ${v.year}: ${v.last}`;
      if (!COUNTER_PREFIXES.includes(prefix))
        planned.push({ row, label, error: `series must be ${COUNTER_PREFIXES.join(', ')}` });
      else if (!year.ok) planned.push({ row, label, error: `year: ${year.reason}` });
      else if (!last.ok) planned.push({ row, label, error: `last number: ${last.reason}` });
      else if (seen.has(`${prefix}|${year.value}`))
        planned.push({ row, label, error: 'this series and year twice in the file' });
      else {
        seen.add(`${prefix}|${year.value}`);
        const now = await getDocCounter(appPool, actor, prefix, year.value);
        if (now !== null && now === last.value) planned.push({ row, label, exists: true });
        else if (now !== null && now > last.value)
          planned.push({
            row,
            label,
            error: `numbers up to ${now} are already issued: a counter only moves forward`,
          });
        else
          planned.push({
            row,
            label,
            apply: async () => {
              const r = await setDocCounter(appPool, actor, { prefix, year: year.value, last: last.value });
              return r.ok ? null : fail(r);
            },
          });
      }
    }
  } else if (kind === 'account_balances') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('account_balances', r.values) }));
    const accounts = await listMoneyAccounts(appPool, actor);
    const byLabel = new Map(accounts.map((a) => [a.label.trim().toLowerCase(), a] as const));
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const account = byLabel.get(v.account.trim().toLowerCase());
      const amount = parseImportAmount(v.amount);
      const asOf = toIsoDate(v.asOf, ctx.dateFormat);
      const label = v.account;
      if (!account)
        planned.push({
          row,
          label,
          error: 'unknown cash or bank account (exact label): create it on the accounts screen first',
        });
      else if (!amount.ok) planned.push({ row, label, error: `amount in MAD: ${amount.reason}` });
      else if (!asOf)
        planned.push({
          row,
          label,
          error: `date not understood or ambiguous (expected ${ctx.dateFormat ?? 'dmy'})`,
        });
      else if (seen.has(account.id)) planned.push({ row, label, error: 'this account twice in the file' });
      else if (account.opening) {
        seen.add(account.id);
        const d = differences([
          ['amount', amount.value, account.opening.amountCentimes],
          ['date', asOf, account.opening.asOf],
        ]);
        planned.push(d.length ? { row, label, error: conflictMessage(d) } : { row, label, exists: true });
      } else {
        seen.add(account.id);
        planned.push({
          row,
          label,
          apply: async () => {
            const r = await setOpeningBalance(appPool, actor, {
              accountId: account.id,
              asOf,
              amountCentimes: amount.value,
              note: nul(v.note) ?? null,
            });
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  } else if (kind === 'cheques_issued') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('cheques_issued', r.values) }));
    const supplierList = await listSuppliers(appPool, actor);
    const suppliers = new Map<string, string>();
    for (const x of supplierList) {
      suppliers.set(x.code.toLowerCase(), x.id);
      suppliers.set(x.name.trim().toLowerCase(), x.id);
    }
    const ambSuppliers = ambiguousKeys(supplierList, (x) => [
      x.code.toLowerCase(),
      x.name.trim().toLowerCase(),
    ]);
    const haveByKey = new Map<string, Awaited<ReturnType<typeof listInstruments>>[number]>();
    for (const i of (await listInstruments(appPool, actor)).filter((x) => x.direction === 'out'))
      haveByKey.set(`${i.partyId}|${(i.number ?? '').toLowerCase()}|${(i.bank ?? '').toLowerCase()}`, i);
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const supplierId = suppliers.get(v.supplier.trim().toLowerCase());
      const m = v.method.trim().toLowerCase();
      const method = ['cheque', 'chèque', 'check'].includes(m)
        ? 'cheque'
        : ['lcn', 'effet'].includes(m)
          ? 'lcn'
          : null;
      const amount = parseImportAmount(v.amount);
      const written = toIsoDate(v.written, ctx.dateFormat);
      const label = `${v.number} ${v.supplier}`;
      const key = `${supplierId}|${v.number.toLowerCase()}|${v.bank.toLowerCase()}`;
      if (ambSuppliers.has(v.supplier.trim().toLowerCase())) planned.push({ row, label, error: AMBIGUOUS });
      else if (!supplierId) planned.push({ row, label, error: 'unknown supplier (code or exact name)' });
      else if (!method) planned.push({ row, label, error: 'type must be cheque or lcn' });
      else if (!v.number.trim()) planned.push({ row, label, error: 'the cheque or LCN number is required' });
      else if (!amount.ok || amount.value <= 0)
        planned.push({
          row,
          label,
          error: `amount in MAD: ${amount.ok ? 'must be above zero' : amount.reason}`,
        });
      else if (!written)
        planned.push({
          row,
          label,
          error: `date not understood or ambiguous (expected ${ctx.dateFormat ?? 'dmy'})`,
        });
      else if (haveByKey.has(key)) {
        const e = haveByKey.get(key)!;
        const d = differences([
          ['amount', amount.value, e.amountCentimes],
          ['type', method, e.method],
          ['written date', written, e.writtenDate],
        ]);
        planned.push(d.length ? { row, label, error: conflictMessage(d) } : { row, label, exists: true });
      } else if (seen.has(key)) planned.push({ row, label, error: 'twice in the file' });
      else {
        seen.add(key);
        planned.push({
          row,
          label,
          apply: async () => {
            const r = await issueInstrument(
              appPool,
              actor,
              {
                supplierId,
                method,
                amountCentimes: amount.value,
                number: v.number,
                bank: nul(v.bank),
                writtenDate: written,
              },
              { today: ctx.today ?? realClock.now().toISOString().slice(0, 10), source: 'opening_30_11' },
            );
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  } else {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('opening_balances', r.values) }));
    const state = await getOpeningState(appPool, actor);
    const date = state.openingDate ?? ctx.openingDate ?? null;
    // R15B-11: the date the operator confirmed is the one that is used. Once the books are opened on a date, a different --opening-date is a
    // contradiction to resolve with the accountant, never silently replaced by the stored one.
    if (state.openingDate && ctx.openingDate && ctx.openingDate !== state.openingDate) {
      return {
        planned: records.map((r) => ({
          row: r.row,
          label: r.values.code ?? '',
          error:
            'the books are already opened on another date than the opening date given: the opening date cannot move; remove the option or give the stored date',
        })),
        missing: [],
      };
    }
    // a party is named by its code or by its exact name (the company's files know names; the codes are made when the party is created)
    const clients = new Map<string, string>();
    const clientList = await listClients(appPool, actor);
    for (const c of clientList) {
      clients.set(c.code.toLowerCase(), c.id);
      clients.set(c.name.trim().toLowerCase(), c.id);
    }
    const suppliers = new Map<string, string>();
    const supplierList = await listSuppliers(appPool, actor);
    for (const x of supplierList) {
      suppliers.set(x.code.toLowerCase(), x.id);
      suppliers.set(x.name.trim().toLowerCase(), x.id);
    }
    for (const a of await listClientAliases(appPool, actor))
      clients.set(a.alias.trim().toLowerCase(), a.clientId);
    const ambClients = ambiguousKeys(clientList, (c) => [c.code.toLowerCase(), c.name.trim().toLowerCase()]);
    const ambSuppliers = ambiguousKeys(supplierList, (x) => [
      x.code.toLowerCase(),
      x.name.trim().toLowerCase(),
    ]);
    const has = new Map(state.parties.map((p) => [`${p.kind}:${p.partyId}`, p]));
    const seenInFile = new Set<string>();
    if (!date) {
      return {
        planned: records.map((r) => ({
          row: r.row,
          label: r.values.code ?? '',
          error: 'no opening date: pass it (--opening-date YYYY-MM-DD)',
        })),
        missing: [],
      };
    }
    let dateDone = state.openingDate !== null;
    for (const { row, values: v } of records) {
      const party = alias(v.party);
      const id =
        party === 'client'
          ? clients.get(v.code.trim().toLowerCase())
          : party === 'supplier'
            ? suppliers.get(v.code.trim().toLowerCase())
            : undefined;
      const amount = parseImportAmount(v.amount);
      const partyKey = v.code.trim().toLowerCase();
      if (
        (party === 'client' && ambClients.has(partyKey)) ||
        (party === 'supplier' && ambSuppliers.has(partyKey))
      )
        planned.push({ row, label: v.code, error: AMBIGUOUS });
      else if (!id)
        planned.push({ row, label: v.code, error: 'unknown client or supplier (code or exact name)' });
      else if (!amount.ok || amount.value <= 0)
        planned.push({
          row,
          label: v.code,
          error: `amount in MAD: ${amount.ok ? 'must be above zero' : amount.reason}`,
        });
      else if (seenInFile.has(`${party}:${id}`))
        // R14-08: a second row for the same party in one workbook is a conflict, never an "already there"
        planned.push({ row, label: v.code, error: 'this party has two opening-balance rows in the file' });
      else if (has.has(`${party}:${id}`)) {
        seenInFile.add(`${party}:${id}`);
        const e = has.get(`${party}:${id}`)!;
        const d = differences([
          ['amount', amount.value, e.amountCentimes],
          ['reference', nul(v.reference), e.reference],
        ]);
        planned.push(
          d.length ? { row, label: v.code, error: conflictMessage(d) } : { row, label: v.code, exists: true },
        );
      } else {
        seenInFile.add(`${party}:${id}`);
        const first = !dateDone;
        dateDone = true;
        planned.push({
          row,
          label: v.code,
          apply: async () => {
            if (first) {
              const d = await enterOpeningDate(appPool, actor, { openingDate: date });
              if (!d.ok && d.error !== 'ALREADY_ENTERED') return fail(d);
              if (!d.ok) {
                // Someone entered a date while this file was being planned: it must be the one that was confirmed.
                const now = await getOpeningState(appPool, actor);
                if (now.openingDate !== date)
                  return 'the books were opened on another date than the one confirmed: run the import again';
              }
            }
            const r = await addPartyOpeningBalance(appPool, actor, {
              ...(party === 'client' ? { clientId: id } : { supplierId: id }),
              amountCentimes: amount.value,
              reference: nul(v.reference) ?? null,
            });
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  }
  // D246 totals control: the MAD amount of each row that has an amount column (the same parser as the rows themselves)
  const amounts = new Map<number, number>();
  if ('amount' in COLUMNS[kind])
    for (const r of rawRecords) {
      const a = parseImportAmount(r.values.amount ?? '');
      if (a.ok) amounts.set(r.row, a.value);
    }
  return { planned, missing: [], amounts };
}

/**
 * R14-08: "already there" means the SAME payload, not just the same key. These are the names of the fields in which what the file says
 * differs from the record that exists. Only what the row actually says is compared (a blank cell is "not said", not "empty"), and
 * only field NAMES are returned, never a value.
 */
function differences(pairs: [name: string, fromFile: unknown, existing: unknown][]): string[] {
  const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());
  return pairs.filter(([, a, b]) => norm(a) !== '' && norm(a) !== norm(b)).map(([n]) => n);
}
const conflictMessage = (fields: string[]) =>
  `conflicts with the record already there (it differs in: ${fields.join(', ')}): the file is blocked, nothing is skipped silently`;

function tally(rows: ImportRow[]): ImportReport['counts'] {
  const counts = { new: 0, exists: 0, error: 0, created: 0, failed: 0 };
  for (const r of rows) counts[r.status]++;
  return counts;
}

/** Validates a sheet and, unless `apply` is false, writes it. Never writes when the dry run found an error. */
export async function runImport(
  kind: ImportKind,
  sheet: Sheet,
  ctx: Ctx & { apply: boolean },
): Promise<ImportReport> {
  // The importer is the owner's (owner and app_admin). Until D245 an office account was stopped only because it could not read the table
  // it wrote to (blind entry); an office role now reads its own side, so the refusal is stated here, not left to a side effect.
  if (ctx.apply && ctx.actor.role !== 'owner' && ctx.actor.role !== 'app_admin')
    throw new Error('the importer writes for the owner and app_admin only');
  const { planned, missing, amounts } = await plan(kind, sheet, ctx);
  const rows: ImportRow[] = planned.map((p) =>
    p.error
      ? { row: p.row, status: 'error', label: p.label, message: p.error }
      : { row: p.row, status: p.exists ? 'exists' : 'new', label: p.label },
  );
  const hasError = missing.length > 0 || rows.some((r) => r.status === 'error');
  // `applyValidRows`: the rows without a problem of a sheet that has some are still applied. Only a caller that rolls everything back
  // when any sheet has a problem may ask for it (the workbook import), so that later sheets are checked against them for real.
  if (ctx.apply && (!hasError || ctx.applyValidRows)) {
    for (const [i, p] of planned.entries()) {
      if (!p.apply) continue;
      const failure = await p.apply();
      rows[i] = failure
        ? { row: p.row, status: 'failed', label: p.label, message: failure }
        : { row: p.row, status: 'created', label: p.label };
      if (failure) break; // stop at the first refusal: what was written is listed, a re-run continues from here
    }
  }
  const hasAmounts = amounts !== undefined && amounts.size > 0;
  const totals = {
    rows: planned.length,
    writable: planned.filter((p) => p.apply).length,
    fileCentimes: hasAmounts ? [...amounts.values()].reduce((a, b) => a + b, 0) : null,
    writableCentimes: hasAmounts
      ? planned.filter((p) => p.apply).reduce((a, p) => a + (amounts.get(p.row) ?? 0), 0)
      : null,
  };
  return { kind, dryRun: !ctx.apply || hasError, rows, missingColumns: missing, counts: tally(rows), totals };
}

export function formatReport(report: ImportReport): string {
  const c = report.counts;
  const lines = [
    `${report.dryRun ? 'DRY RUN (nothing written)' : 'IMPORT DONE'}: ${report.kind}`,
    report.missingColumns.length ? `Missing columns: ${report.missingColumns.join(', ')}` : '',
    `new ${c.new} · already there ${c.exists} · errors ${c.error} · created ${c.created} · failed ${c.failed}`,
    `TOTALS CONTROL: ${report.totals.rows} row(s) read, ${report.totals.writable} to write` +
      (report.totals.fileCentimes === null
        ? ''
        : `; file ${(report.totals.fileCentimes / 100).toFixed(2)} MAD, to write ${((report.totals.writableCentimes ?? 0) / 100).toFixed(2)} MAD`) +
      ' (compare with the Excel closing figures before applying)',
    ...report.rows
      .filter((r) => r.status === 'error' || r.status === 'failed')
      .map((r) => `  line ${r.row} ${r.label}: ${r.message}`),
  ].filter(Boolean);
  return lines.join('\n');
}

/** The fields of a kind and the header names accepted by default (the starting point of a mapping file). */
export const defaultColumnsOf = (kind: ImportKind): Record<string, readonly string[]> => COLUMNS[kind];
export const fieldsOf = (kind: ImportKind): string[] => Object.keys(COLUMNS[kind]);
