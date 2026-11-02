import type pg from 'pg';
import { parseCentimes } from '@/lib/money';
import {
  createClient,
  createConcreteType,
  createListPrice,
  createSupplier,
  createTruck,
  listClients,
  listConcreteTypes,
  listPlants,
  listSellingPrices,
  listSuppliers,
  listTrucks,
  parseCapacityM3,
  parseClientInput,
  parseConcreteTypeInput,
  parseTruckInput,
  SUPPLIER_CATEGORIES,
} from '@/modules/master-data';
import { addPartyOpeningBalance, enterOpeningDate, getOpeningState } from '@/modules/ledger';
import type { SessionUser } from '@/modules/platform-security';
import { type Sheet, toIsoDate, toRecords } from '../domain/sheet';

// Excel importers (REQUIREMENTS-V1 §14). Every row goes through the same parser and the same service as the screen, so the same
// rules, row-level security and audit apply. A DRY RUN (the default) validates every row, looks for what exists already, writes
// nothing, and says what a real run would do. A real run only starts when the dry run found no error, and re-running is safe:
// what exists is skipped, never doubled.

export const IMPORT_KINDS = [
  'concrete_types',
  'clients',
  'suppliers',
  'trucks',
  'selling_prices',
  'opening_balances',
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
}

interface Planned {
  row: number;
  label: string;
  error?: string;
  exists?: boolean;
  apply?: () => Promise<string | null>;
}
interface Ctx {
  appPool: pg.Pool;
  actor: SessionUser;
  openingDate?: string;
}

const COLUMNS = {
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
  selling_prices: {
    type: ['type', 'code', 'classe', 'beton'],
    price: ['price', 'prix', 'prix ht', 'prix m3'],
    from: ['from', 'date', 'a partir du', 'à partir du', 'effective'],
  },
  opening_balances: {
    party: ['party', 'tiers', 'type tiers'],
    code: ['code', 'code tiers'],
    amount: ['amount', 'montant', 'solde'],
    reference: ['reference', 'référence', 'ref'],
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
): Promise<{ planned: Planned[]; missing: string[] }> {
  const { records: rawRecords, missing } = toRecords(sheet, COLUMNS[kind]);
  // the optional columns do not make a file unusable
  const required: Record<ImportKind, string[]> = {
    concrete_types: ['code', 'label'],
    clients: ['name', 'kind'],
    suppliers: ['name', 'category'],
    trucks: ['code', 'plate'],
    selling_prices: ['type', 'price', 'from'],
    opening_balances: ['party', 'code', 'amount'],
  };
  const realMissing = missing.filter((m) => required[kind].includes(m));
  if (realMissing.length) return { planned: [], missing: realMissing };
  const { appPool, actor } = ctx;
  const planned: Planned[] = [];

  if (kind === 'concrete_types') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('concrete_types', r.values) }));
    const have = new Set((await listConcreteTypes(appPool, actor)).map((t) => t.code));
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const input = { code: v.code, label: v.label };
      const parsed = parseConcreteTypeInput(input);
      if (!parsed.ok) planned.push({ row, label: v.code, error: 'invalid code or label' });
      else if (have.has(parsed.value.code)) planned.push({ row, label: parsed.value.code, exists: true });
      else if (seen.has(parsed.value.code))
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
    const names = new Set(existing.map((c) => c.name.trim().toLowerCase()));
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
      else if (names.has(key)) planned.push({ row, label: v.name, exists: true });
      else if (seenN.has(key)) planned.push({ row, label: v.name, error: 'twice in the file' });
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
    const names = new Set(existing.map((s) => s.name.trim().toLowerCase()));
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
      } else if (names.has(key)) planned.push({ row, label: v.name, exists: true });
      else if (seen.has(key)) planned.push({ row, label: v.name, error: 'twice in the file' });
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
  } else if (kind === 'trucks') {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('trucks', r.values) }));
    const have = new Set((await listTrucks(appPool, actor)).flatMap((t) => [t.code, t.plate.toUpperCase()]));
    const plants = new Map(
      (await listPlants(appPool, actor)).filter((p) => p.status === 'active').map((p) => [p.code, p.id]),
    );
    const seen = new Set<string>();
    for (const { row, values: v } of records) {
      const kindV = v.kind ? alias(v.kind) : 'mixer';
      const cap = v.capacity ? parseCapacityM3(v.capacity) : null;
      const plantId = v.plant ? (plants.get(v.plant.trim().toUpperCase()) ?? 'unknown') : null;
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
      else if (have.has(parsed.value.code) || have.has(plate))
        planned.push({ row, label: v.code, exists: true });
      else if (seen.has(parsed.value.code) || seen.has(plate))
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
    const existing = (await listSellingPrices(appPool, actor)).filter((p) => p.clientId === null);
    for (const { row, values: v } of records) {
      const typeId = types.get(v.type.trim().toUpperCase());
      const cents = parseCentimes(v.price);
      const from = toIsoDate(v.from);
      const label = `${v.type} ${v.from}`;
      if (!typeId) planned.push({ row, label, error: 'unknown concrete type (import the types first)' });
      else if (cents === null || cents <= 0)
        planned.push({ row, label, error: 'price in MAD HT per m³, at most two decimals' });
      else if (!from) planned.push({ row, label, error: 'date not understood (dd/mm/yyyy or yyyy-mm-dd)' });
      else if (existing.some((p) => p.concreteTypeId === typeId && p.effectiveFrom === from))
        planned.push({ row, label, exists: true });
      else
        planned.push({
          row,
          label,
          apply: async () => {
            const r = await createListPrice(appPool, actor, {
              concreteTypeId: typeId,
              priceHtPerM3Centimes: cents,
              effectiveFrom: from,
            });
            return r.ok ? null : fail(r);
          },
        });
    }
  } else {
    const records = rawRecords.map((r) => ({ row: r.row, values: full('opening_balances', r.values) }));
    const state = await getOpeningState(appPool, actor);
    const date = state.openingDate ?? ctx.openingDate ?? null;
    const clients = new Map((await listClients(appPool, actor)).map((c) => [c.code, c.id]));
    const suppliers = new Map((await listSuppliers(appPool, actor)).map((s) => [s.code, s.id]));
    const has = new Set(state.parties.map((p) => `${p.kind}:${p.partyId}`));
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
          ? clients.get(v.code.trim().toUpperCase())
          : party === 'supplier'
            ? suppliers.get(v.code.trim().toUpperCase())
            : undefined;
      const cents = parseCentimes(v.amount);
      if (!id) planned.push({ row, label: v.code, error: 'unknown client or supplier code' });
      else if (cents === null || cents <= 0)
        planned.push({ row, label: v.code, error: 'amount in MAD, positive, at most two decimals' });
      else if (has.has(`${party}:${id}`)) planned.push({ row, label: v.code, exists: true });
      else {
        has.add(`${party}:${id}`);
        const first = !dateDone;
        dateDone = true;
        planned.push({
          row,
          label: v.code,
          apply: async () => {
            if (first) {
              const d = await enterOpeningDate(appPool, actor, { openingDate: date });
              if (!d.ok && d.error !== 'ALREADY_ENTERED') return fail(d);
            }
            const r = await addPartyOpeningBalance(appPool, actor, {
              ...(party === 'client' ? { clientId: id } : { supplierId: id }),
              amountCentimes: cents,
              reference: nul(v.reference) ?? null,
            });
            return r.ok ? null : fail(r);
          },
        });
      }
    }
  }
  return { planned, missing: [] };
}

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
  const { planned, missing } = await plan(kind, sheet, ctx);
  const rows: ImportRow[] = planned.map((p) =>
    p.error
      ? { row: p.row, status: 'error', label: p.label, message: p.error }
      : { row: p.row, status: p.exists ? 'exists' : 'new', label: p.label },
  );
  const hasError = missing.length > 0 || rows.some((r) => r.status === 'error');
  if (ctx.apply && !hasError) {
    for (const [i, p] of planned.entries()) {
      if (!p.apply) continue;
      const failure = await p.apply();
      rows[i] = failure
        ? { row: p.row, status: 'failed', label: p.label, message: failure }
        : { row: p.row, status: 'created', label: p.label };
      if (failure) break; // stop at the first refusal: what was written is listed, a re-run continues from here
    }
  }
  return { kind, dryRun: !ctx.apply || hasError, rows, missingColumns: missing, counts: tally(rows) };
}

export function formatReport(report: ImportReport): string {
  const c = report.counts;
  const lines = [
    `${report.dryRun ? 'DRY RUN (nothing written)' : 'IMPORT DONE'}: ${report.kind}`,
    report.missingColumns.length ? `Missing columns: ${report.missingColumns.join(', ')}` : '',
    `new ${c.new} · already there ${c.exists} · errors ${c.error} · created ${c.created} · failed ${c.failed}`,
    ...report.rows
      .filter((r) => r.status === 'error' || r.status === 'failed')
      .map((r) => `  line ${r.row} ${r.label}: ${r.message}`),
  ].filter(Boolean);
  return lines.join('\n');
}
