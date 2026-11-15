import type pg from 'pg';
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';

/**
 * The detail of the opening position at 30 Nov (T19-close A, D246): per-invoice open items of a client or supplier, and loans / leasing with
 * their instalment schedule. Owner and app_admin (`opening.write`; the doors check the actor again). Rows are insert-only and marked opening_30_11.
 */
export type OpeningDetailError = 'INVALID' | 'DUPLICATE' | 'NO_LINE' | 'OVER_LINE' | 'NOT_FOUND';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const itemSchema = z
  .object({
    clientId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
    invoiceNumber: z.string().trim().min(1).max(60),
    invoiceDate: date,
    dueDate: date,
    amountCentimes: z.number().int().positive(),
    balanceCentimes: z.number().int().positive(),
  })
  .refine((v) => (v.clientId === undefined) !== (v.supplierId === undefined))
  .refine((v) => v.balanceCentimes <= v.amountCentimes)
  .refine((v) => v.dueDate >= v.invoiceDate);

function failure(error: unknown): OpeningDetailError {
  const e = error as { code?: string; message?: string };
  if (isUniqueViolation(error)) return 'DUPLICATE';
  if (e.code === '23514' && /no opening balance line/.test(e.message ?? '')) return 'NO_LINE';
  if (e.code === '23514' && /more than the opening balance line/.test(e.message ?? '')) return 'OVER_LINE';
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (e.code === '23514') return 'INVALID';
  throw error;
}

export async function addOpeningOpenItem(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, OpeningDetailError>> {
  await require(appPool, actor, 'opening.write');
  const p = itemSchema.safeParse(input);
  if (!p.success) return err('INVALID');
  const v = p.data;
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.add_opening_open_item($1, $2, $3, $4, $5, $6, $7) as id', [
        v.clientId ?? null,
        v.supplierId ?? null,
        v.invoiceNumber,
        v.invoiceDate,
        v.dueDate,
        v.amountCentimes,
        v.balanceCentimes,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    return err(failure(error));
  }
}

export interface OpeningOpenItemView {
  kind: 'client' | 'supplier';
  partyId: string;
  partyName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  amountCentimes: number;
  balanceCentimes: number;
  /** The party's opening line and the sum of its items (they must be equal once the sheet is loaded). */
  lineCentimes: number;
  itemsTotalCentimes: number;
}

export async function listOpeningOpenItems(
  appPool: pg.Pool,
  actor: SessionUser,
  kind: 'client' | 'supplier' | null = null,
): Promise<OpeningOpenItemView[]> {
  await require(appPool, actor, 'opening.write');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      o_kind: 'client' | 'supplier';
      o_party_id: string;
      o_party_name: string;
      o_invoice_number: string;
      o_invoice_date: string;
      o_due_date: string;
      o_amount: string;
      o_balance: string;
      o_line: string;
      o_items_total: string;
    }>(
      `select o_kind, o_party_id, o_party_name, o_invoice_number, to_char(o_invoice_date, 'YYYY-MM-DD') as o_invoice_date,
              to_char(o_due_date, 'YYYY-MM-DD') as o_due_date, o_amount::text, o_balance::text, o_line::text, o_items_total::text
         from public.opening_open_item_list($1, 10000)`,
      [kind],
    ),
  );
  return rows.map((r) => ({
    kind: r.o_kind,
    partyId: r.o_party_id,
    partyName: r.o_party_name,
    invoiceNumber: r.o_invoice_number,
    invoiceDate: r.o_invoice_date,
    dueDate: r.o_due_date,
    amountCentimes: Number(r.o_amount),
    balanceCentimes: Number(r.o_balance),
    lineCentimes: Number(r.o_line),
    itemsTotalCentimes: Number(r.o_items_total),
  }));
}

const obligationSchema = z.object({
  kind: z.enum(['loan', 'leasing']),
  lender: z.string().trim().min(2).max(120),
  reference: z.string().trim().min(1).max(60),
});
const instalmentSchema = z.object({
  obligationId: z.string().uuid(),
  dueDate: date,
  amountCentimes: z.number().int().positive(),
});

export async function addOpeningObligation(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, OpeningDetailError>> {
  await require(appPool, actor, 'opening.write');
  const p = obligationSchema.safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.add_opening_obligation($1, $2, $3) as id', [
        p.data.kind,
        p.data.lender,
        p.data.reference,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    return err(failure(error));
  }
}

export async function addOpeningInstalment(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, OpeningDetailError>> {
  await require(appPool, actor, 'opening.write');
  const p = instalmentSchema.safeParse(input);
  if (!p.success) return err('INVALID');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<{ id: string }>('select public.add_opening_instalment($1, $2, $3) as id', [
        p.data.obligationId,
        p.data.dueDate,
        p.data.amountCentimes,
      ]),
    );
    return ok({ id: rows[0]!.id });
  } catch (error) {
    return err(failure(error));
  }
}

export interface OpeningObligationView {
  id: string;
  kind: 'loan' | 'leasing';
  lender: string;
  reference: string;
  totalCentimes: number;
  instalments: { dueDate: string; amountCentimes: number }[];
}

export async function listOpeningObligations(
  appPool: pg.Pool,
  actor: SessionUser,
): Promise<OpeningObligationView[]> {
  await require(appPool, actor, 'opening.write');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      o_id: string;
      o_kind: 'loan' | 'leasing';
      o_lender: string;
      o_reference: string;
      o_due: string | null;
      o_amount: string | null;
      o_total: string | null;
    }>(
      `select o_id, o_kind, o_lender, o_reference, to_char(o_due, 'YYYY-MM-DD') as o_due, o_amount::text, o_total::text
         from public.opening_obligation_list(20000)`,
    ),
  );
  const byId = new Map<string, OpeningObligationView>();
  for (const r of rows) {
    const v = byId.get(r.o_id) ?? {
      id: r.o_id,
      kind: r.o_kind,
      lender: r.o_lender,
      reference: r.o_reference,
      totalCentimes: Number(r.o_total ?? 0),
      instalments: [],
    };
    if (r.o_due && r.o_amount) v.instalments.push({ dueDate: r.o_due, amountCentimes: Number(r.o_amount) });
    byId.set(r.o_id, v);
  }
  return [...byId.values()];
}
