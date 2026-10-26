import type pg from 'pg';
import { z } from 'zod';
import { centimes, mulDivRound } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import { type Effect, visibleEffects } from '../domain/effects';

export type AvoirError = 'INVALID' | 'NOT_FOUND' | 'NOTHING_TO_CREDIT' | 'CONFLICT';

/** A load that was refused or brought back after it was billed and has no avoir yet. */
export interface AvoirCandidate {
  deliveryId: string;
  blNo: string;
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  lostL: number;
  lossReason: string;
  unitPriceHtCentimes: number;
  amountHtCentimes: number;
  amountVatCentimes: number;
  amountTtcCentimes: number;
}

export interface AvoirView {
  id: string;
  number: string;
  avoirDate: string;
  invoiceId: string;
  invoiceNumber: string;
  deliveryId: string;
  blNo: string;
  lossReason: string;
  clientId: string;
  clientName: string;
  volumeL: number;
  unitPriceHtCentimes: number;
  vatRateBp: number;
  totalHtCentimes: number;
  totalVatCentimes: number;
  totalTtcCentimes: number;
  reason: string;
  /** What the avoir took off the plan items of the order; the rest (if any) is a credit in the client's favour. */
  appliedCentimes: number;
}

/**
 * The refused or brought-back loads that a live invoice bills and no avoir credits yet (AC-INT-12; DECISIONS 93: concrete that
 * was refused stays billed until the owner issues an avoir). The amount is the lost litres at the invoice line's price, one
 * rounding per figure. Owner and support (money).
 */
export async function listAvoirCandidates(appPool: pg.Pool, actor: SessionUser): Promise<AvoirCandidate[]> {
  await require(appPool, actor, 'avoirs.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      delivery_id: string;
      bl_no: string;
      invoice_id: string;
      number: string;
      client_name: string;
      lost_l: number;
      reason: string;
      price: string;
      vat_rate_bp: number;
    }>(
      `select d.id as delivery_id, d.bl_no, i.id as invoice_id, i.number, i.client_name, x.volume_l as lost_l, x.reason,
              l.unit_price_ht_centimes::text as price, i.vat_rate_bp
         from delivery_loss x
         join delivery d on d.id = x.delivery_id and d.reverses_id is null
         join invoice_line l on l.delivery_id = d.id
         join invoice i on i.id = l.invoice_id and i.credit_note_of is null
        where not exists (select 1 from invoice c where c.credit_note_of = i.id)
          and not exists (select 1 from avoir a where a.loss_id = x.id)
        order by d.bl_no`,
    ),
  );
  return rows.map((r) => {
    const ht = mulDivRound(centimes(Number(r.price)), r.lost_l, 1000);
    const vat = mulDivRound(ht, r.vat_rate_bp, 10000);
    return {
      deliveryId: r.delivery_id,
      blNo: r.bl_no,
      invoiceId: r.invoice_id,
      invoiceNumber: r.number,
      clientName: r.client_name,
      lostL: r.lost_l,
      lossReason: r.reason,
      unitPriceHtCentimes: Number(r.price),
      amountHtCentimes: ht,
      amountVatCentimes: vat,
      amountTtcCentimes: Number(ht) + Number(vat),
    };
  });
}

/** The avoirs issued, newest first, with the invoice, the BL and the loss they reference. Owner and support. */
export async function listAvoirs(appPool: pg.Pool, actor: SessionUser): Promise<AvoirView[]> {
  await require(appPool, actor, 'avoirs.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<{
      id: string;
      number: string;
      avoir_date: string;
      invoice_id: string;
      invoice_number: string;
      delivery_id: string;
      bl_no: string;
      loss_reason: string;
      client_id: string;
      client_name: string;
      volume_l: number;
      price: string;
      vat_rate_bp: number;
      ht: string;
      vat: string;
      ttc: string;
      reason: string;
      applied: string;
    }>(
      `select a.id, a.number, to_char(a.avoir_date, 'YYYY-MM-DD') as avoir_date, a.invoice_id, i.number as invoice_number,
              a.delivery_id, d.bl_no, x.reason as loss_reason, a.client_id, c.name as client_name, a.volume_l,
              a.unit_price_ht_centimes::text as price, a.vat_rate_bp, a.total_ht_centimes::text as ht,
              a.total_vat_centimes::text as vat, a.total_ttc_centimes::text as ttc, a.reason,
              coalesce((select sum(al.amount_centimes) from allocation al where al.avoir_id = a.id), 0)::text as applied
         from avoir a
         join invoice i on i.id = a.invoice_id
         join delivery d on d.id = a.delivery_id
         join delivery_loss x on x.id = a.loss_id
         join client c on c.id = a.client_id
        order by a.avoir_date desc, a.number desc`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    avoirDate: r.avoir_date,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    deliveryId: r.delivery_id,
    blNo: r.bl_no,
    lossReason: r.loss_reason,
    clientId: r.client_id,
    clientName: r.client_name,
    volumeL: r.volume_l,
    unitPriceHtCentimes: Number(r.price),
    vatRateBp: r.vat_rate_bp,
    totalHtCentimes: Number(r.ht),
    totalVatCentimes: Number(r.vat),
    totalTtcCentimes: Number(r.ttc),
    reason: r.reason,
    appliedCentimes: Number(r.applied),
  }));
}

const issueSchema = z.object({
  deliveryId: z.uuid(),
  reason: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(3).max(500)),
});

/**
 * Issues the avoir of a refused or brought-back load: the owner only, after a fresh second factor (the action layer asks for
 * it). It references the invoice, the BL and the loss record, has its own AV number, never touches the invoice, and lowers
 * what the client owes. The database decides everything but the reason.
 */
export async function issueAvoir(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<{ number: string; effects: Effect[] }, AvoirError>> {
  await require(appPool, actor, 'avoirs.issue');
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  try {
    return await inRequest(
      appPool,
      actor,
      async (tx): Promise<Result<{ number: string; effects: Effect[] }, AvoirError>> => {
        const made = await tx.query<{ number: string | null }>(
          'select public.issue_avoir($1, $2, $3) as number',
          [parsed.data.deliveryId, parsed.data.reason, deps.today],
        );
        const number = made.rows[0]?.number;
        if (!number) return err('NOTHING_TO_CREDIT');
        const row = await tx.query<{ ttc: string; client_code: string }>(
          `select a.total_ttc_centimes::text as ttc, c.code as client_code from avoir a join client c on c.id = a.client_id where a.number = $1`,
          [number],
        );
        const effects: Effect[] = [
          { kind: 'document', document: 'avoir', code: number },
          {
            kind: 'receivable',
            clientCode: row.rows[0]?.client_code ?? null,
            amountCentimes: -Number(row.rows[0]?.ttc ?? 0),
          },
        ];
        return ok({ number, effects: visibleEffects(effects, actor.role) });
      },
    );
  } catch (error) {
    const e = error as { code?: string };
    if (isMalformedId(error)) return err('NOT_FOUND');
    if (e.code === '23505' || e.code === '40001' || e.code === '40P01') return err('CONFLICT');
    throw error;
  }
}
