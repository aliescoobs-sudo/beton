import type pg from 'pg';
import { z } from 'zod';
import { parseCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { can, inRequest, require, type SessionUser } from '@/modules/platform-security';

/**
 * Outgoing payment control (T19 item 5, D247). The rules are in the doors and in the trigger of migration 0245: prepared by one user, validated by ANOTHER
 * (middle band) or approved by the owner (above the upper limit), then issued carrying the request id; nobody decides on their own preparation.
 */
export type RequestState = 'prepared' | 'validated' | 'approved' | 'rejected' | 'issued';
export type PaymentControlError = 'INVALID' | 'NOT_ALLOWED' | 'REFUSED' | 'STEP_UP_REQUIRED';

export interface PaymentRequestView {
  id: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  method: 'cash' | 'cheque' | 'lcn' | 'transfer';
  amountCentimes: number;
  number: string | null;
  bank: string | null;
  writtenDate: string | null;
  note: string | null;
  state: RequestState;
  level: 'small' | 'validate' | 'owner';
  preparedBy: string | null;
  createdAt: string;
}

const prepareSchema = z.object({
  supplierId: z.uuid(),
  method: z.enum(['cash', 'cheque', 'lcn', 'transfer']),
  amount: z.string().transform((v, ctx) => {
    const c = parseCentimes(v);
    if (c === null || c <= 0) ctx.addIssue({ code: 'custom', message: 'amount' });
    return c ?? 0;
  }),
  number: z.string().trim().max(60).optional(),
  bank: z.string().trim().max(80).optional(),
  writtenDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().trim().max(500).optional(),
});

async function run<T>(
  appPool: pg.Pool,
  actor: SessionUser,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<Result<T, PaymentControlError>> {
  try {
    return ok(await inRequest(appPool, actor, fn));
  } catch (error) {
    const code = (error as { code?: string }).code;
    // the door of T19c A: an approval above the upper limit without the fresh second factor (the mark `app.step_up`)
    if (code === '42501' && /fresh second factor/.test((error as Error).message ?? ''))
      return err<PaymentControlError>('STEP_UP_REQUIRED');
    if (code === '42501') return err<PaymentControlError>('NOT_ALLOWED');
    if (code === '23514' || code === '23503') return err<PaymentControlError>('REFUSED');
    throw error;
  }
}

export async function preparePayment(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  await require(appPool, actor, 'payments.prepare');
  const p = prepareSchema.safeParse(input);
  if (!p.success) return err<PaymentControlError>('INVALID');
  const v = p.data;
  return run(appPool, actor, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'select public.prepare_outgoing_payment($1, $2, $3, $4, $5, $6::date, $7) as id',
      [
        v.supplierId,
        v.method,
        v.amount,
        v.number || null,
        v.bank || null,
        v.writtenDate ?? null,
        v.note || null,
      ],
    );
    return { id: rows[0]!.id };
  });
}

export async function decidePayment(appPool: pg.Pool, actor: SessionUser, input: unknown) {
  await require(appPool, actor, 'payments.decide');
  const p = z
    .object({
      id: z.uuid(),
      decision: z.enum(['validate', 'approve', 'reject']),
      note: z.string().trim().max(500).optional(),
    })
    .safeParse(input);
  if (!p.success) return err<PaymentControlError>('INVALID');
  return run(appPool, actor, async (tx) => {
    await tx.query('select public.decide_outgoing_payment($1, $2, $3)', [
      p.data.id,
      p.data.decision,
      p.data.note || null,
    ]);
    return true as const;
  });
}

export async function listPaymentRequests(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<PaymentRequestView[]> {
  await require(appPool, actor, can(actor.role, 'payments.prepare') ? 'payments.prepare' : 'payments.decide');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<Record<string, string | null | undefined>>(
      `select o_id, o_supplier_id, o_supplier_code, o_supplier_name, o_method, o_amount::text amt, o_number, o_bank, to_char(o_written, 'YYYY-MM-DD') w,
              o_note, o_state, o_level, o_prepared_by, to_char(o_created_at at time zone 'UTC', 'YYYY-MM-DD') c from public.outgoing_payment_requests(1000)`,
    ),
  );
  return rows.map((r) => ({
    id: String(r.o_id),
    supplierId: String(r.o_supplier_id),
    supplierCode: String(r.o_supplier_code),
    supplierName: String(r.o_supplier_name),
    method: r.o_method as PaymentRequestView['method'],
    amountCentimes: Number(r.amt),
    number: r.o_number ?? null,
    bank: r.o_bank ?? null,
    writtenDate: r.w ?? null,
    note: r.o_note ?? null,
    state: r.o_state as RequestState,
    level: r.o_level as PaymentRequestView['level'],
    preparedBy: r.o_prepared_by ?? null,
    createdAt: String(r.c),
  }));
}

/**
 * The owner's inbox entry (T19-close B, D247): the outgoing payments ABOVE the upper limit that wait for the owner's approval. Owner and app_admin only
 * (`approvals.decide`); the doors check the actor again and the owner never decides on their own preparation.
 */
export async function listPaymentApprovals(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<PaymentRequestView[]> {
  await require(appPool, actor, 'approvals.decide');
  return (await listPaymentRequests(appPool, actor)).filter(
    (r) => r.state === 'prepared' && r.level === 'owner',
  );
}

export interface DueTomorrow {
  id: string;
  supplierCode: string;
  supplierName: string;
  method: string;
  number: string | null;
  bank: string | null;
  amountCentimes: number;
  due: string;
}

/** J-1: the cheques and LCN issued that fall due the day after `today` and are not cleared. */
export async function listDueTomorrow(
  appPool: pg.Pool,
  actor: SessionUser,
  today: string,
): Promise<DueTomorrow[]> {
  await require(appPool, actor, 'payments.prepare');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<Record<string, string | null | undefined>>(
      `select o_id, o_supplier_code, o_supplier_name, o_method, o_number, o_bank, o_amount::text amt, to_char(o_due, 'YYYY-MM-DD') due from public.outgoing_due_tomorrow($1::date)`,
      [today],
    ),
  );
  return rows.map((r) => ({
    id: String(r.o_id),
    supplierCode: String(r.o_supplier_code),
    supplierName: String(r.o_supplier_name),
    method: String(r.o_method),
    number: r.o_number ?? null,
    bank: r.o_bank ?? null,
    amountCentimes: Number(r.amt),
    due: String(r.due),
  }));
}

export interface SmallPaymentReview {
  id: string;
  supplierName: string;
  method: string;
  amountCentimes: number;
  by: string | null;
  hasNumber: boolean;
}

/** The owner's daily review of small outgoing payments entered by an office role on `day` (owner and app_admin). */
export async function listSmallPaymentsForReview(
  appPool: pg.Pool,
  actor: SessionUser,
  day: string,
): Promise<SmallPaymentReview[]> {
  await require(appPool, actor, 'payments.decide');
  if (!can(actor.role, 'payments.prepare')) return [];
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<Record<string, string | boolean | null>>(
      `select o_id, o_supplier_name, o_method, o_amount::text amt, o_by, o_has_number from public.small_outgoing_review($1::date)`,
      [day],
    ),
  );
  return rows.map((r) => ({
    id: String(r.o_id),
    supplierName: String(r.o_supplier_name),
    method: String(r.o_method),
    amountCentimes: Number(r.amt),
    by: (r.o_by as string | null) ?? null,
    hasNumber: Boolean(r.o_has_number),
  }));
}
