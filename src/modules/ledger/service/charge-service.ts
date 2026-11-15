import type pg from 'pg';
import { z } from 'zod';
import { parseCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';

/**
 * The charges register (T19 item 6, D245, D247). Every rule lives in the doors (migration 0244): who may record, who may validate or approve, that nobody
 * decides on their own preparation, that a charge cannot be paid before its control, that a charge without a supporting document is flagged. The
 * amounts are integer centimes; a typed amount is parsed once by the shared money parser. Nothing is computed here but the TTC shown.
 */
export const CHARGE_CATEGORIES = [
  'rent',
  'electricity_water',
  'telecom',
  'insurance',
  'maintenance',
  'transport',
  'taxes_fees',
  'bank_fees',
  'supplies',
  'other',
] as const;
export const CHARGE_MODES = ['cash', 'cheque', 'transfer', 'card'] as const;
export type ChargeStatus =
  | 'recorded'
  | 'pending_validation'
  | 'pending_approval'
  | 'validated'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'reversed';
export type ChargeError = 'INVALID' | 'NOT_ALLOWED' | 'REFUSED';

export interface ChargeView {
  id: string;
  date: string;
  beneficiary: string;
  category: string;
  htCentimes: number;
  vatCentimes: number;
  ttcCentimes: number;
  mode: string;
  status: ChargeStatus;
  level: 'small' | 'validate' | 'owner';
  documentRef: string | null;
  noDocument: boolean;
  preparedBy: string | null;
  decidedBy: string | null;
  note: string | null;
}

const money = z.string().transform((v, ctx) => {
  const c = parseCentimes(v);
  if (c === null || c < 0) ctx.addIssue({ code: 'custom', message: 'amount' });
  return c ?? 0;
});
const recordSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  beneficiary: z.string().trim().min(2).max(120),
  category: z.enum(CHARGE_CATEGORIES),
  ht: money,
  vat: money,
  mode: z.enum(CHARGE_MODES),
  documentRef: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional(),
});

async function run<T>(
  appPool: pg.Pool,
  actor: SessionUser,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<Result<T, ChargeError>> {
  try {
    return ok(await inRequest(appPool, actor, fn));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') return err<ChargeError>('NOT_ALLOWED');
    if (code === '23514' || code === '23502') return err<ChargeError>('REFUSED');
    throw error;
  }
}

export async function recordCharge(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  await require(appPool, actor, 'charges.write');
  const p = recordSchema.safeParse(input);
  if (!p.success || p.data.ht + p.data.vat <= 0) return err<ChargeError>('INVALID');
  const v = p.data;
  return run(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'select public.record_charge($1, $2, $3, $4, $5, $6, $7, $8) as id',
      [v.date, v.beneficiary, v.category, v.ht, v.vat, v.mode, v.documentRef || null, v.note || null],
    );
    return { id: rows[0]!.id };
  });
}

export async function decideCharge(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  await require(appPool, actor, 'charges.decide');
  const p = z
    .object({
      id: z.uuid(),
      decision: z.enum(['validate', 'approve', 'reject']),
      note: z.string().trim().max(500).optional(),
    })
    .safeParse(input);
  if (!p.success) return err<ChargeError>('INVALID');
  return run(appPool, actor, async (tx) => {
    await tx.query('select public.decide_charge($1, $2, $3)', [
      p.data.id,
      p.data.decision,
      p.data.note || null,
    ]);
    return true as const;
  });
}

export async function markChargePaid(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  await require(appPool, actor, 'charges.write');
  const p = z.object({ id: z.uuid() }).safeParse(input);
  if (!p.success) return err<ChargeError>('INVALID');
  return run(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{ ok: boolean }>('select public.mark_charge_paid($1) as ok', [p.data.id]);
    return { withDocument: rows[0]!.ok };
  });
}

export async function addChargeDocument(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  await require(appPool, actor, 'charges.write');
  const p = z.object({ id: z.uuid(), ref: z.string().trim().min(1).max(80) }).safeParse(input);
  if (!p.success) return err<ChargeError>('INVALID');
  return run(appPool, actor, async (tx) => {
    await tx.query('select public.add_charge_document($1, $2)', [p.data.id, p.data.ref]);
    return true as const;
  });
}

export async function listCharges(
  appPool: pg.Pool,
  actor: SessionUser,
  range: { from?: string | null; to?: string | null } = {},
): Promise<ChargeView[]> {
  // the Responsable reads only what waits for its validation (the door filters); the others read the register
  await require(appPool, actor, can(actor.role, 'charges.read') ? 'charges.read' : 'charges.decide');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<Record<string, string | boolean | null>>(
      `select o_id, to_char(o_date, 'YYYY-MM-DD') d, o_beneficiary, o_category, o_ht::text ht, o_vat::text vat, o_ttc::text ttc, o_mode, o_status, o_level,
              o_document_ref, o_no_document, o_prepared_by, o_decided_by, o_note
         from public.charge_list($1::date, $2::date, 1000)`,
      [range.from ?? null, range.to ?? null],
    ),
  );
  return rows.map((r) => ({
    id: String(r.o_id),
    date: String(r.d),
    beneficiary: String(r.o_beneficiary),
    category: String(r.o_category),
    htCentimes: Number(r.ht),
    vatCentimes: Number(r.vat),
    ttcCentimes: Number(r.ttc),
    mode: String(r.o_mode),
    status: r.o_status as ChargeStatus,
    level: r.o_level as ChargeView['level'],
    documentRef: (r.o_document_ref as string | null) ?? null,
    noDocument: Boolean(r.o_no_document),
    preparedBy: (r.o_prepared_by as string | null) ?? null,
    decidedBy: (r.o_decided_by as string | null) ?? null,
    note: (r.o_note as string | null) ?? null,
  }));
}

/** The CSV of the register (the export pattern of the statements): one line per charge, amounts in MAD with a decimal comma, no hidden formula. */
export function chargesToCsv(rows: ChargeView[]): string {
  const mad = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const cell = (v: string) => `"${v.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const head = [
    'date',
    'beneficiary',
    'category',
    'ht',
    'vat',
    'ttc',
    'mode',
    'status',
    'document',
    'no_document',
  ];
  return [
    head.join(';'),
    ...rows.map((r) =>
      [
        r.date,
        cell(r.beneficiary),
        r.category,
        mad(r.htCentimes),
        mad(r.vatCentimes),
        mad(r.ttcCentimes),
        r.mode,
        r.status,
        cell(r.documentRef ?? ''),
        r.noDocument ? 'yes' : 'no',
      ].join(';'),
    ),
  ].join('\n');
}
