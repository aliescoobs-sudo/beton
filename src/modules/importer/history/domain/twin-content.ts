import type { DeliveryRow, ExpenseRow } from './parse';

// R19-03: a marker sheet is not proof that a file is synthetic. In the training instance EVERY retained field of a row (and of a quarantined row's raw
// cells, and of a corrected one) must match what the twin generator can write, field by field: a name is `<letters> FICTIF` (with the spellings the
// generator makes), a site is `CHANTIER FICTIF <n>`, a type, a pump and a truck are from the generator's lists and shapes, an observation is empty or the one
// twin phrase, a delivery note is digits, an amount is a number, a legacy value is a twin driver name or a twin additive. Anything else, in ANY field,
// refuses the file. The functions return FIELD NAMES only (never a cell), so a report can say which field without carrying its text.

const fold = (s: string): string =>
  s
    .normalize('NFC')
    .replace(/[\s  ]+/g, ' ')
    .trim();
const up = (s: string): string => fold(s).toUpperCase();

const DRIVER_NAMES = ['SAMIR', 'LAHCEN', 'ZINEB', 'YOUNES', 'NADIA', 'RACHID'].map((n) => `${n} FICTIF`);
const ADDITIVES = ['HT', 'PLASTIFIANT', 'SIKA FICTIF'];
const TYPES = new Set(['B25', 'B 25', 'B25HYD', 'BB25', 'B26', 'B27', 'B 27']);
const PUMPS = new Set(['', 'POMPE', 'P', 'GOULOTTE', 'G', 'P SITRAD']);
const EXPENSE_LABEL =
  /^(GASOIL|PNEU|PNEUS|FILTRE|AVANCE|BUREAU|DIVERS FICTIF|REPARATION FICTIF|ENTRETIEN FICTIF)( [0-9]{1,6}([.,][0-9]{1,2})? L)?$/;

const isEmpty = (s: string): boolean => fold(s) === '';
/** The generator's client spellings: `<2 or 3 syllables> FICTIF`, with ` 1`/` 2`, a double space, lower case, two letters swapped, or the first word doubled-spaced. */
const clientOk = (s: string): boolean => /^[A-Z]{4,6} FICTIF( [12])?$/.test(up(s));
const siteOk = (s: string): boolean => isEmpty(s) || /^CHANTIER FICTIF [0-9]{1,2}$/.test(up(s));
const truckOk = (s: string): boolean =>
  isEmpty(s) || /^[0-9]{1,5}$/.test(fold(s)) || /^FX[ -]?[0-9]{4}$/.test(up(s));
const driverOk = (s: string): boolean => isEmpty(s) || DRIVER_NAMES.includes(up(s));
const blOk = (s: string): boolean => isEmpty(s) || /^[0-9]{1,14}$/.test(fold(s));
const noteOk = (s: string): boolean => isEmpty(s) || up(s) === 'POUR LE COMPTE DE PARTENAIRE FICTIF';
const typeOk = (s: string): boolean => isEmpty(s) || TYPES.has(up(s));
const pumpOk = (s: string): boolean => PUMPS.has(up(s));
const legacyOk = (k: string, v: string): boolean =>
  (k === 'comercial' && (isEmpty(v) || DRIVER_NAMES.includes(up(v)))) ||
  (k === 'code_client' && isEmpty(v)) ||
  (k === 'adjuvant' && (isEmpty(v) || ADDITIVES.includes(up(v)))) ||
  (k === 'taxbasis' && (isEmpty(v) || ['HT', 'TTC'].includes(up(v))));
const amountOk = (s: string): boolean => /^[0-9]{1,6}([.,][0-9]{1,2})?$/.test(s.replace(/[\s  ]/g, ''));
const m3Ok = (s: string): boolean => isEmpty(s) || /^[0-9]{1,3}([.,][0-9]{1,2})?$/.test(fold(s));
const dateOk = (s: string): boolean =>
  isEmpty(s) ||
  /^[0-9]{1,6}(\.0+)?$/.test(fold(s)) ||
  /^[0-9]{2}\/[0-9]{2}\/20[0-9]{2}$/.test(fold(s)) ||
  /^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(fold(s));

/** The fields of a delivery row that carry something the twin cannot write. */
export function deliveryContamination(r: DeliveryRow): string[] {
  const bad: string[] = [];
  if (!clientOk(r.client)) bad.push('client');
  if (!siteOk(r.site)) bad.push('site');
  if (!typeOk(r.typeRaw)) bad.push('type');
  if (!pumpOk(r.pumpRaw)) bad.push('pump');
  if (!truckOk(r.truck)) bad.push('truck');
  if (!driverOk(r.driver)) bad.push('driver');
  if (!blOk(r.bl)) bad.push('bl');
  if (!noteOk(r.note)) bad.push('note');
  for (const [k, v] of Object.entries(r.legacy)) if (!legacyOk(k, v)) bad.push(`legacy:${k}`);
  return bad;
}

/** The fields of an expense row that carry something the twin cannot write. */
export function expenseContamination(r: ExpenseRow): string[] {
  const bad: string[] = [];
  if (!EXPENSE_LABEL.test(up(r.label))) bad.push('label');
  if (!truckOk(r.truck)) bad.push('truck');
  for (const [k, v] of Object.entries(r.legacy)) if (!legacyOk(k, v)) bad.push(`legacy:${k}`);
  return bad;
}

/** The raw cells of a quarantined (or corrected) row, by field name: every key must be one a sheet can have, every value one the twin can write. */
export function rawContamination(kind: 'deliveries' | 'expenses', raw: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const field = k.startsWith('legacy:') ? 'legacy' : k;
    const ok =
      kind === 'deliveries'
        ? field === 'date'
          ? dateOk(v)
          : field === 'client'
            ? isEmpty(v) || clientOk(v)
            : field === 'site'
              ? siteOk(v)
              : field === 'm3'
                ? m3Ok(v)
                : field === 'type'
                  ? typeOk(v)
                  : field === 'pump'
                    ? pumpOk(v)
                    : field === 'truck'
                      ? truckOk(v)
                      : field === 'driver'
                        ? driverOk(v)
                        : field === 'bl'
                          ? blOk(v)
                          : field === 'observations'
                            ? noteOk(v)
                            : field === 'taxbasis' || field === 'adjuvant'
                              ? legacyOk(field, v)
                              : field === 'legacy'
                                ? legacyOk(k.slice('legacy:'.length), v)
                                : false
        : field === 'date'
          ? dateOk(v)
          : field === 'label'
            ? isEmpty(v) || EXPENSE_LABEL.test(up(v))
            : field === 'amount'
              ? isEmpty(v) || amountOk(v)
              : field === 'truck'
                ? truckOk(v)
                : false;
    if (!ok) bad.push(k.startsWith('legacy:') ? 'legacy' : k);
  }
  return [...new Set(bad)];
}
