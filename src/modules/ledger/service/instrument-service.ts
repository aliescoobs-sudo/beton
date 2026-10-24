import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { centimes, negateCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import { isEarly, isPostDated } from '../domain/instrument-dates';
import {
  parseCancelInput,
  parseClearInput,
  parseDepositInput,
  parseIssueInput,
  parseReceiveInput,
  parseReverseInput,
} from '../domain/instrument-input';
import type { InstrumentDirection, InstrumentMethod, InstrumentState } from '../domain/instrument';

export type InstrumentError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'PARTY_ARCHIVED'
  | 'ACCOUNT_MISMATCH'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'NOTHING_TO_ALLOCATE';

/** What a write returns to the caller: the identity, never an amount (office enters blind, DECISIONS 81). */
export interface InstrumentRef {
  id: string;
}

export function instrumentFailure(error: unknown): InstrumentError {
  const e = error as { code?: string; message?: string; constraint?: string };
  const message = e.message ?? '';
  if (e.code === '23514') {
    if (/illegal transition/.test(message)) return 'ILLEGAL_TRANSITION';
    if (/not active/.test(message)) return 'PARTY_ARCHIVED';
    if (/account/.test(message)) return 'ACCOUNT_MISMATCH';
    if (/unknown/.test(message)) return 'NOT_FOUND';
    return 'INVALID';
  }
  if (e.code === '23505') return e.constraint === 'payment_instrument_paper_idx' ? 'DUPLICATE' : 'CONFLICT';
  if (e.code === '23503' || isMalformedId(error)) return 'NOT_FOUND';
  if (e.code === '40001' || e.code === '40P01') return 'CONFLICT';
  throw error;
}

class NothingToAllocate extends Error {}

async function insertEvent(
  tx: pg.PoolClient,
  actor: SessionUser,
  e: { instrumentId: string; event: string; date: string; accountId?: string | null; reason?: string | null },
): Promise<void> {
  // No RETURNING: office has no SELECT policy.
  await tx.query(
    `insert into instrument_event (id, instrument_id, event, at_date, money_account_id, reason, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), e.instrumentId, e.event, e.date, e.accountId ?? null, e.reason ?? null, actor.id],
  );
}

async function enter(
  appPool: pg.Pool,
  actor: SessionUser,
  direction: InstrumentDirection,
  v: {
    method: InstrumentMethod;
    amountCentimes: number;
    number: string | null;
    bank: string | null;
    writtenDate: string | null;
    partyId: string;
    orderCode?: string | null;
  },
  today: string,
): Promise<Result<InstrumentRef, InstrumentError>> {
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, async (tx) => {
      await tx.query(
        `insert into payment_instrument (id, direction, method, amount_centimes, client_id, supplier_id, number, bank,
                                         written_date, received_date, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          direction,
          v.method,
          v.amountCentimes,
          direction === 'in' ? v.partyId : null,
          direction === 'out' ? v.partyId : null,
          v.number,
          v.bank,
          v.writtenDate,
          today,
          actor.id,
        ],
      );
      await insertEvent(tx, actor, {
        instrumentId: id,
        event: direction === 'in' ? 'received' : 'issued',
        date: today,
      });
      if (v.method === 'cash') {
        // Cash changes hands on the day: received (or issued) and cleared into (out of) the caisse.
        const caisse = await tx.query<{ id: string }>('select public.default_cash_account() as id');
        await insertEvent(tx, actor, {
          instrumentId: id,
          event: 'cleared',
          date: today,
          accountId: caisse.rows[0]?.id,
        });
      }
      if (v.orderCode) {
        // Covers the oldest open items of that order; a code that fits nothing rolls the whole entry back.
        const covered = await tx.query<{ n: number }>('select public.allocate_to_order($1, $2) as n', [
          id,
          v.orderCode,
        ]);
        if (!covered.rows[0]?.n) throw new NothingToAllocate();
      }
    });
    return ok({ id });
  } catch (error) {
    if (error instanceof NothingToAllocate) return err('NOTHING_TO_ALLOCATE');
    return err(instrumentFailure(error));
  }
}

/** A payment from a client arrives. Cash is cleared into the caisse the same day; the rest waits for the owner. */
export async function receiveInstrument(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<InstrumentRef, InstrumentError>> {
  await require(appPool, actor, 'instruments.write');
  const parsed = parseReceiveInput(input);
  if (!parsed.ok) return err('INVALID');
  return enter(appPool, actor, 'in', { ...parsed.value, partyId: parsed.value.clientId }, deps.today);
}

/** A payment to a supplier is handed over. */
export async function issueInstrument(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<InstrumentRef, InstrumentError>> {
  await require(appPool, actor, 'instruments.write');
  const parsed = parseIssueInput(input);
  if (!parsed.ok) return err('INVALID');
  return enter(appPool, actor, 'out', { ...parsed.value, partyId: parsed.value.supplierId }, deps.today);
}

/** The owner confirms the money reached (or left) an account on a date. Writes the one signed movement (trigger). */
export async function clearInstrument(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<InstrumentRef, InstrumentError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = parseClearInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    await inRequest(appPool, actor, (tx) =>
      insertEvent(tx, actor, {
        instrumentId: v.instrumentId,
        event: 'cleared',
        date: v.date,
        accountId: v.accountId,
      }),
    );
    return ok({ id: v.instrumentId });
  } catch (error) {
    return err(instrumentFailure(error));
  }
}

/**
 * "Remise en banque": the owner deposits a selection of received cheques and LCN to a bank account on a date. One event
 * per instrument, all or nothing. A post-dated cheque may be presented before its written date: accepted, and flagged
 * `early` when listed (AC-LED-14), never refused.
 */
export async function depositInstruments(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ deposited: number }, InstrumentError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = parseDepositInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    await inRequest(appPool, actor, async (tx) => {
      for (const instrumentId of v.instrumentIds) {
        await insertEvent(tx, actor, {
          instrumentId,
          event: 'deposited',
          date: v.date,
          accountId: v.accountId,
        });
      }
    });
    return ok({ deposited: v.instrumentIds.length });
  } catch (error) {
    return err(instrumentFailure(error));
  }
}

/** The owner cancels an instrument that is not final, with a reason. Office asks for a correction instead. */
export async function cancelInstrument(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<InstrumentRef, InstrumentError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = parseCancelInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    await inRequest(appPool, actor, (tx) =>
      insertEvent(tx, actor, {
        instrumentId: v.instrumentId,
        event: 'cancelled',
        date: v.date,
        reason: v.reason,
      }),
    );
    return ok({ id: v.instrumentId });
  } catch (error) {
    return err(instrumentFailure(error));
  }
}

/** A clearing entered by mistake: the owner posts the reversing movement (never an edit), with a reason. */
export async function reverseMovement(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
  deps: { today: string },
): Promise<Result<{ id: string }, InstrumentError>> {
  await require(appPool, actor, 'ledger.reverse');
  const parsed = parseReverseInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const id = randomUUID();
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<{ id: string }, InstrumentError>> => {
      const original = await tx.query<{ id: string; account_id: string; amount_centimes: string }>(
        'select id, account_id, amount_centimes::text from money_movement where id = $1',
        [v.movementId],
      );
      const row = original.rows[0];
      if (!row) return err('NOT_FOUND');
      await tx.query(
        `insert into money_movement (id, account_id, amount_centimes, movement_date, source, source_id, reverses_id, reason, created_by)
         values ($1, $2, $3, $4, 'reversal', $5, $5, $6, $7)`,
        [
          id,
          row.account_id,
          negateCentimes(centimes(Number(row.amount_centimes))),
          deps.today,
          row.id,
          v.reason,
          actor.id,
        ],
      );
      return ok({ id });
    });
  } catch (error) {
    return err(instrumentFailure(error));
  }
}

export interface InstrumentEventView {
  event: InstrumentState;
  atDate: string;
  accountId: string | null;
  reason: string | null;
  /** Deposited or cleared before the date written on the paper (AC-LED-14). */
  early: boolean;
}

export interface InstrumentView {
  id: string;
  direction: InstrumentDirection;
  method: InstrumentMethod;
  amountCentimes: number;
  partyId: string;
  partyName: string;
  number: string | null;
  bank: string | null;
  writtenDate: string | null;
  receivedDate: string;
  postDated: boolean;
  state: InstrumentState;
  stateDate: string;
  events: InstrumentEventView[];
}

interface InstrumentRow {
  id: string;
  direction: InstrumentDirection;
  method: InstrumentMethod;
  amount_centimes: string;
  party_id: string;
  party_name: string;
  number: string | null;
  bank: string | null;
  written_date: string | null;
  received_date: string;
  events: { event: InstrumentState; at_date: string; account_id: string | null; reason: string | null }[];
}

/** The instruments with their events, newest first. Owner and support only (the page records the support view). */
export async function listInstruments(appPool: pg.Pool, actor: SessionUser): Promise<InstrumentView[]> {
  await require(appPool, actor, 'instruments.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<InstrumentRow>(
      `select i.id, i.direction, i.method, i.amount_centimes::text, coalesce(i.client_id, i.supplier_id) as party_id,
              coalesce(c.name, s.name) as party_name, i.number, i.bank,
              to_char(i.written_date, 'YYYY-MM-DD') as written_date, to_char(i.received_date, 'YYYY-MM-DD') as received_date,
              (select json_agg(json_build_object('event', e.event, 'at_date', to_char(e.at_date, 'YYYY-MM-DD'),
                                                 'account_id', e.money_account_id, 'reason', e.reason) order by e.seq)
                 from instrument_event e where e.instrument_id = i.id) as events
         from payment_instrument i
         left join client c on c.id = i.client_id left join supplier s on s.id = i.supplier_id
        order by i.created_at desc, i.id`,
    ),
  );
  return rows.map((r) => {
    const events = r.events.map((e) => ({
      event: e.event,
      atDate: e.at_date,
      accountId: e.account_id,
      reason: e.reason,
      early: (e.event === 'deposited' || e.event === 'cleared') && isEarly(e.at_date, r.written_date),
    }));
    const last = events[events.length - 1] as InstrumentEventView;
    return {
      id: r.id,
      direction: r.direction,
      method: r.method,
      amountCentimes: Number(r.amount_centimes),
      partyId: r.party_id,
      partyName: r.party_name,
      number: r.number,
      bank: r.bank,
      writtenDate: r.written_date,
      receivedDate: r.received_date,
      postDated: r.written_date !== null && isPostDated(r.written_date, r.received_date),
      state: last.event,
      stateDate: last.atDate,
      events,
    };
  });
}
