import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import {
  inRequest,
  isMalformedId,
  isUniqueViolation,
  require,
  type SessionUser,
} from '@/modules/platform-security';
import { parseOpeningInput, parsePartyOpeningInput } from '../domain/opening';

export type OpeningError =
  'INVALID' | 'ALREADY_ENTERED' | 'OPENING_FIRST' | 'DUPLICATE' | 'NOT_FOUND' | 'PARTY_ARCHIVED';

export interface OpeningState {
  openingDate: string | null;
  parties: {
    id: string;
    kind: 'client' | 'supplier';
    partyId: string;
    partyName: string;
    amountCentimes: number;
    reference: string | null;
    /** false when the line is backed by per-invoice open items. */
    agingUnknown: boolean;
  }[];
}

/** The owner enters the opening date once; a second entry is refused (the singleton row). */
export async function enterOpeningDate(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ openingDate: string }, OpeningError>> {
  await require(appPool, actor, 'opening.write');
  const parsed = parseOpeningInput(input);
  if (!parsed.ok) return err('INVALID');
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(`insert into ledger_opening (opening_date, created_by) values ($1, $2)`, [
        parsed.value.openingDate,
        actor.id,
      ]),
    );
    return ok({ openingDate: parsed.value.openingDate });
  } catch (error) {
    if (isUniqueViolation(error)) return err('ALREADY_ENTERED');
    throw error;
  }
}

/** What a client owes us, or we owe a supplier, on the opening date. One per party. */
export async function addPartyOpeningBalance(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  /** T19-close A: true when the line is the sum of per-invoice open items that follow (the age of the debt is known). */
  options: { agingKnown?: boolean } = {},
): Promise<Result<{ id: string }, OpeningError>> {
  await require(appPool, actor, 'opening.write');
  const parsed = parsePartyOpeningInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        // D246: every row of the opening position is marked; the age of the debt is unknown until the sheet carries it per invoice
        `insert into opening_party_balance (id, client_id, supplier_id, amount_centimes, reference, created_by, source, aging_unknown)
         values ($1, $2, $3, $4, $5, $6, 'opening_30_11', $7)`,
        [
          id,
          v.clientId ?? null,
          v.supplierId ?? null,
          v.amountCentimes,
          v.reference ?? null,
          actor.id,
          !options.agingKnown,
        ],
      ),
    );
    return ok({ id });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (isUniqueViolation(error)) return err('DUPLICATE');
    if (e.code === '23514' && /opening date first/.test(e.message ?? '')) return err('OPENING_FIRST');
    if (e.code === '23514' && /not active/.test(e.message ?? '')) return err('PARTY_ARCHIVED');
    if (e.code === '23503' || isMalformedId(error)) return err('NOT_FOUND');
    throw error;
  }
}

export async function getOpeningState(appPool: pg.Pool, actor: SessionUser): Promise<OpeningState> {
  await require(appPool, actor, 'opening.read');
  return inRequest(appPool, actor, async (tx) => {
    const date = await tx.query<{ d: string }>(
      `select to_char(opening_date, 'YYYY-MM-DD') as d from ledger_opening`,
    );
    const parties = await tx.query<{
      id: string;
      client_id: string | null;
      party_id: string;
      name: string;
      amount: string;
      reference: string | null;
      aging_unknown: boolean;
    }>(
      `select b.id, b.client_id, coalesce(b.client_id, b.supplier_id) as party_id, coalesce(c.name, s.name) as name,
              b.amount_centimes::text as amount, b.reference, b.aging_unknown
         from opening_party_balance b left join client c on c.id = b.client_id left join supplier s on s.id = b.supplier_id
        order by (b.client_id is null), lower(coalesce(c.name, s.name))`,
    );
    return {
      openingDate: date.rows[0]?.d ?? null,
      parties: parties.rows.map((r) => ({
        id: r.id,
        kind: r.client_id ? ('client' as const) : ('supplier' as const),
        partyId: r.party_id,
        partyName: r.name,
        amountCentimes: Number(r.amount),
        reference: r.reference,
        agingUnknown: r.aging_unknown,
      })),
    };
  });
}
