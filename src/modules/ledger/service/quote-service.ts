import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { centimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import {
  can,
  inRequest,
  isMalformedId,
  parameterOrDefault,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { type Effect, visibleEffects } from '../domain/effects';
import { DEFAULT_QUOTE_DAYS, parseQuoteInput, quoteValidUntil } from '../domain/quote';
import { computeTotals } from '../domain/totals';
import { nextDocNumber } from './doc-number';
import { ledgerParameter } from './order-service';

export type QuoteError =
  'INVALID' | 'NOT_FOUND' | 'CLIENT_ARCHIVED' | 'TYPE_INACTIVE' | 'NO_PRICE' | 'CONFLICT';

/** What a quote creation returns: identity and code, plus the effects the role may see (no amount for office). */
export interface CreatedQuote {
  id: string;
  code: string;
  effects: Effect[];
}

const quoteFailure = (error: unknown): QuoteError => {
  const { code, message } = error as { code?: string; message?: string };
  if (code === '23514') {
    if (/client is not active/.test(message ?? '')) return 'CLIENT_ARCHIVED';
    if (/concrete type is not active/.test(message ?? '')) return 'TYPE_INACTIVE';
    if (/price is not the one in force/.test(message ?? '')) return 'NO_PRICE';
    return 'INVALID';
  }
  if (code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (code === '40001' || code === '40P01' || code === '23505') return 'CONFLICT';
  throw error;
};

/** The rows of a quote in the caller's transaction (also used by the pilot scenario). */
export async function insertQuoteRows(
  tx: pg.PoolClient,
  actor: { id: string; role?: SessionUser['role'] },
  v: { clientId: string; concreteTypeId: string; volumeL: number; validDays?: number | null },
  today: string,
): Promise<Result<CreatedQuote, QuoteError>> {
  const client = await tx.query<{ status: string; code: string }>(
    'select status, code from client where id = $1',
    [v.clientId],
  );
  if (!client.rows[0]) return err('NOT_FOUND');
  if (client.rows[0].status !== 'active') return err('CLIENT_ARCHIVED');
  const price = await tx.query<{ id: string; price_ht_per_m3_centimes: string }>(
    'select id, price_ht_per_m3_centimes from public.resolve_selling_price($1, $2, $3)',
    [v.concreteTypeId, v.clientId, today],
  );
  if (!price.rows[0]) return err('NO_PRICE');
  const unit = centimes(Number(price.rows[0].price_ht_per_m3_centimes));
  const vatRateBp = await ledgerParameter(tx, 'vat_rate_bp');
  const totals = computeTotals(v.volumeL, unit, vatRateBp);
  if (!totals.ok) return err('INVALID');
  const id = randomUUID();
  const code = await nextDocNumber(tx, 'DV', today);
  // No RETURNING: office has no SELECT policy on the table (blind entry).
  await tx.query(
    `insert into quote (id, code, client_id, concrete_type_id, volume_l, quote_date, valid_until, selling_price_id,
                        unit_price_ht_centimes, vat_rate_bp, total_ht_centimes, total_vat_centimes, total_ttc_centimes, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id,
      code,
      v.clientId,
      v.concreteTypeId,
      v.volumeL,
      today,
      quoteValidUntil(today, v.validDays),
      price.rows[0].id,
      unit,
      vatRateBp,
      totals.value.totalHt,
      totals.value.totalVat,
      totals.value.totalTtc,
      actor.id,
    ],
  );
  // A quote has no ledger effect: only its document number.
  const effects: Effect[] = [{ kind: 'document', document: 'quote', code }];
  return ok({ id, code, effects: actor.role ? visibleEffects(effects, actor.role) : effects });
}

/**
 * Quotes a volume of concrete for a client at the price in force (AC-LED-23). No payment plan and no ledger effect. Owner and
 * office; office is blind: it gets the code, never an amount.
 */
export async function createQuote(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<CreatedQuote, QuoteError>> {
  await require(appPool, actor, 'quotes.write');
  const parsed = parseQuoteInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    // Office (no read of prices) gets its quote made entirely inside the database: the code comes back, nothing else.
    if (!can(actor.role, 'quotes.read'))
      return await inRequest(appPool, actor, async (tx): Promise<Result<CreatedQuote, QuoteError>> => {
        const v = parsed.value;
        const made = await tx.query<{ code: string; id: string }>(
          'select code, id from public.create_quote($1, $2, $3, $4, $5, $6)',
          [
            v.clientId,
            v.concreteTypeId,
            v.volumeL,
            v.validDays ?? DEFAULT_QUOTE_DAYS,
            deps.today,
            parameterOrDefault('vat_rate_bp', undefined),
          ],
        );
        const code = made.rows[0]?.code;
        if (!code) return err('INVALID');
        return ok({
          id: made.rows[0]?.id ?? '',
          code,
          effects: visibleEffects([{ kind: 'document', document: 'quote', code }], actor.role),
        });
      });
    return await inRequest(appPool, actor, (tx) => insertQuoteRows(tx, actor, parsed.value, deps.today));
  } catch (error) {
    return err(quoteFailure(error));
  }
}

export interface QuoteView {
  id: string;
  code: string;
  clientId: string;
  clientCode: string;
  clientName: string;
  clientIce: string | null;
  typeCode: string;
  typeLabel: string;
  volumeL: number;
  quoteDate: string;
  validUntil: string;
  unitPriceHtCentimes: number;
  vatRateBp: number;
  totalHtCentimes: number;
  totalVatCentimes: number;
  totalTtcCentimes: number;
  /** The code of the order saved from this quote, once there is one. */
  convertedOrderCode: string | null;
  concreteTypeId: string;
}

const SELECT = `select q.id, q.code, q.client_id, c.code as client_code, c.name as client_name, c.ice as client_ice, t.code as type_code,
       t.label as type_label, q.volume_l, to_char(q.quote_date, 'YYYY-MM-DD') as quote_date,
       to_char(q.valid_until, 'YYYY-MM-DD') as valid_until, q.unit_price_ht_centimes::text as unit, q.vat_rate_bp,
       q.total_ht_centimes::text as ht, q.total_vat_centimes::text as vat, q.total_ttc_centimes::text as ttc,
       (select o.code from sales_order o where o.quote_id = q.id) as converted, q.concrete_type_id
  from quote q join client c on c.id = q.client_id join concrete_type t on t.id = q.concrete_type_id`;

interface Row {
  id: string;
  code: string;
  client_id: string;
  client_code: string;
  client_name: string;
  client_ice: string | null;
  type_code: string;
  type_label: string;
  volume_l: number;
  quote_date: string;
  valid_until: string;
  unit: string;
  vat_rate_bp: number;
  ht: string;
  vat: string;
  ttc: string;
  converted: string | null;
  concrete_type_id: string;
}
const toView = (r: Row): QuoteView => ({
  id: r.id,
  code: r.code,
  clientId: r.client_id,
  clientCode: r.client_code,
  clientName: r.client_name,
  clientIce: r.client_ice,
  typeCode: r.type_code,
  typeLabel: r.type_label,
  volumeL: r.volume_l,
  quoteDate: r.quote_date,
  validUntil: r.valid_until,
  unitPriceHtCentimes: Number(r.unit),
  vatRateBp: r.vat_rate_bp,
  totalHtCentimes: Number(r.ht),
  totalVatCentimes: Number(r.vat),
  totalTtcCentimes: Number(r.ttc),
  convertedOrderCode: r.converted,
  concreteTypeId: r.concrete_type_id,
});

/** The quotes, newest first. Owner and support (money). */
export async function listQuotes(appPool: pg.Pool, actor: SessionUser): Promise<QuoteView[]> {
  await require(appPool, actor, 'quotes.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<Row>(`${SELECT} order by q.quote_date desc, q.code desc`),
  );
  return rows.map(toView);
}

export async function getQuote(
  appPool: pg.Pool,
  actor: SessionUser,
  quoteId: string,
): Promise<QuoteView | null> {
  await require(appPool, actor, 'quotes.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<Row>(`${SELECT} where q.id = $1`, [quoteId]),
    );
    return rows[0] ? toView(rows[0]) : null;
  } catch (error) {
    if (isMalformedId(error)) return null;
    throw error;
  }
}
