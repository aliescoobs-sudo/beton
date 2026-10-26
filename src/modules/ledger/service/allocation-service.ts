import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { centimes, negateCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import { parseAllocateInput, parseUnallocateInput } from '../domain/instrument-input';
import { type ItemState, itemState } from '../domain/plan-state';
import { type InstrumentError, instrumentFailure } from './instrument-service';

export type AllocationError = InstrumentError | 'EXCEEDS_INSTRUMENT' | 'EXCEEDS_ITEM' | 'NOT_ALLOWED';

function allocationFailure(error: unknown): AllocationError {
  const e = error as { code?: string; message?: string };
  if (e.code === '23514') {
    const m = e.message ?? '';
    if (/more than the instrument/.test(m)) return 'EXCEEDS_INSTRUMENT';
    if (/more than the item/.test(m)) return 'EXCEEDS_ITEM';
    if (/unknown/.test(m)) return 'NOT_FOUND';
    return 'NOT_ALLOWED';
  }
  if (e.code === '23505') return 'CONFLICT';
  return instrumentFailure(error);
}

/** The owner covers a plan item with (part of) an instrument. Office covers an order by code when it receives (see receiveInstrument). */
export async function allocate(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, AllocationError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = parseAllocateInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, created_by) values ($1, $2, $3, $4, $5)`,
        [id, v.instrumentId, v.itemId, v.amountCentimes, actor.id],
      ),
    );
    return ok({ id });
  } catch (error) {
    return err(allocationFailure(error));
  }
}

/** Undoes an allocation with a negated row and a reason; the original stays. */
export async function unallocate(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, AllocationError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = parseUnallocateInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const id = randomUUID();
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<{ id: string }, AllocationError>> => {
      const original = await tx.query<{
        instrument_id: string;
        payment_plan_item_id: string;
        amount_centimes: string;
        invoice_id: string | null;
      }>(
        'select instrument_id, payment_plan_item_id, amount_centimes::text, invoice_id from allocation where id = $1',
        [v.allocationId],
      );
      const row = original.rows[0];
      if (!row) return err('NOT_FOUND');
      await tx.query(
        `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, reverses_id, reason, invoice_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          row.instrument_id,
          row.payment_plan_item_id,
          negateCentimes(centimes(Number(row.amount_centimes))),
          v.allocationId,
          v.reason,
          row.invoice_id,
          actor.id,
        ],
      );
      return ok({ id });
    });
  } catch (error) {
    return err(allocationFailure(error));
  }
}

export interface ItemCoverage {
  itemId: string;
  seq: number;
  method: string;
  dueDate: string;
  amountCentimes: number;
  coveredCentimes: number;
  state: ItemState;
}

/** The items of an order with what covers each and its derived state, for the roles that read money (owner, support). */
export async function orderCoverage(
  appPool: pg.Pool,
  actor: SessionUser,
  orderId: string,
  deps: { today: string },
): Promise<ItemCoverage[]> {
  await require(appPool, actor, 'orders.read_money');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      seq: number;
      method: string;
      due_date: string;
      amount: string;
      covered: string;
      cancelled: boolean;
    }>(
      `select i.id, i.seq, i.method, to_char(i.due_date, 'YYYY-MM-DD') as due_date, i.amount_centimes::text as amount,
              coalesce((select sum(a.amount_centimes) from allocation a where a.payment_plan_item_id = i.id), 0)::text as covered,
              exists (select 1 from sales_order r where r.reverses_id = i.order_id) as cancelled
         from payment_plan_item i where i.order_id = $1 and i.reverses_id is null order by i.seq`,
      [orderId],
    ),
  );
  return rows.map((r) => ({
    itemId: r.id,
    seq: r.seq,
    method: r.method,
    dueDate: r.due_date,
    amountCentimes: Number(r.amount),
    coveredCentimes: Number(r.covered),
    state: itemState({
      amountCentimes: Number(r.amount),
      coveredCentimes: Number(r.covered),
      dueDate: r.due_date,
      today: deps.today,
      cancelled: r.cancelled,
    }),
  }));
}

export interface OpenInvoice {
  invoiceId: string;
  number: string;
  clientId: string;
  clientName: string;
  dueDate: string;
  totalTtcCentimes: number;
  openCentimes: number;
}

/**
 * The invoices still open, oldest due date first (derived, never stored; owner and support): what the database derived as
 * paid is taken off each total. Used to pick the invoice a payment is directed to.
 */
export async function listOpenInvoices(appPool: pg.Pool, actor: SessionUser): Promise<OpenInvoice[]> {
  await require(appPool, actor, 'invoices.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      number: string;
      client_id: string;
      client_name: string;
      due: string;
      total: string;
      paid: string;
    }>(
      `select i.id, i.number, i.client_id, i.client_name, to_char(i.due_date, 'YYYY-MM-DD') as due,
              s.total_ttc_centimes::text as total, s.paid_centimes::text as paid
         from invoice i join public.invoice_payment_state() s on s.invoice_id = i.id
        where s.total_ttc_centimes > s.paid_centimes
        order by i.due_date, i.invoice_date, i.number`,
    ),
  );
  return rows.map((r) => ({
    invoiceId: r.id,
    number: r.number,
    clientId: r.client_id,
    clientName: r.client_name,
    dueDate: r.due,
    totalTtcCentimes: Number(r.total),
    openCentimes: Number(r.total) - Number(r.paid),
  }));
}

const directSchema = z.object({
  instrumentId: z.uuid(),
  invoiceId: z.uuid(),
  amountCentimes: z.number().int().positive().safe(),
  reason: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(3).max(500)),
});

/**
 * The owner directs (part of) a payment to one invoice instead of the oldest first (AC-INT-10). A reason is required; the
 * rows the database writes carry the invoice and the reason, which is what the audit log keeps of the override. Returns what
 * was allocated (0 when the invoice is not open for this client or the instrument has nothing left).
 */
export async function allocateToInvoice(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ allocatedCentimes: number }, AllocationError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = directSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ n: string }>('select public.allocate_to_invoice($1, $2, $3, $4)::text as n', [
        v.instrumentId,
        v.invoiceId,
        v.amountCentimes,
        v.reason,
      ]),
    );
    const allocated = Number(rows[0]?.n ?? 0);
    return allocated > 0 ? ok({ allocatedCentimes: allocated }) : err('NOT_ALLOWED');
  } catch (error) {
    return err(allocationFailure(error));
  }
}
