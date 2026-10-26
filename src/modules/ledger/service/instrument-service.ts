import { type Effect, visibleEffects } from '../domain/effects';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { centimes, negateCentimes } from '@/lib/money';
import { err, ok, type Result } from '@/lib/result';
import { inRequest, isMalformedId, require, type SessionUser } from '@/modules/platform-security';
import { isEarly, isPostDated } from '../domain/instrument-dates';
import {
  type DepositInput,
  parseBounceInput,
  parseCancelInput,
  parseDisputeInput,
  parseRegularizeInput,
  parseClearInput,
  parseDepositInput,
  parseIssueInput,
  parseReceiveInput,
  parseReverseInput,
} from '../domain/instrument-input';
import { regularizationDeadline } from '../domain/instrument';
import type { InstrumentDirection, InstrumentMethod, InstrumentState } from '../domain/instrument';

export type InstrumentError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'PARTY_ARCHIVED'
  | 'ACCOUNT_MISMATCH'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'NOTHING_TO_ALLOCATE'
  | 'WINDOW_CLOSED'
  | 'COVERING_INVALID';

/** What a write returns to the caller: the identity, never an amount (office enters blind, DECISIONS 81). */
export interface InstrumentRef {
  id: string;
  /** What the entry changed, filtered by role: the money facts only for a role that reads money. */
  effects?: Effect[];
}

export function instrumentFailure(error: unknown): InstrumentError {
  const e = error as { code?: string; message?: string; constraint?: string };
  const message = e.message ?? '';
  if (e.code === '23514') {
    if (/illegal transition/.test(message)) return 'ILLEGAL_TRANSITION';
    if (/window is closed/.test(message)) return 'WINDOW_CLOSED';
    if (/covering instrument/.test(message)) return 'COVERING_INVALID';
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
  e: {
    id?: string;
    instrumentId: string;
    event: string;
    date: string;
    accountId?: string | null;
    reason?: string | null;
    coveringInstrumentId?: string | null;
  },
): Promise<void> {
  // No RETURNING: office has no SELECT policy.
  await tx.query(
    `insert into instrument_event (id, instrument_id, event, at_date, money_account_id, reason, covering_instrument_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.id ?? randomUUID(),
      e.instrumentId,
      e.event,
      e.date,
      e.accountId ?? null,
      e.reason ?? null,
      e.coveringInstrumentId ?? null,
      actor.id,
    ],
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
    purchaseCode?: string | null;
    allocateToClient?: boolean | null;
  },
  today: string,
): Promise<Result<InstrumentRef, InstrumentError>> {
  const id = randomUUID();
  let coveredCentimes = 0;
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
        // What was covered, as the actor can read it (office reads no allocation, and sees no money effect anyway).
        const sum = await tx.query<{ s: string }>(
          'select coalesce(sum(amount_centimes), 0)::text as s from allocation where instrument_id = $1',
          [id],
        );
        coveredCentimes = Number(sum.rows[0]?.s ?? 0);
      }
      if (direction === 'in' && v.allocateToClient && !v.orderCode) {
        // No order named: the client's open invoices, oldest due date first (AC-INT-09). Nothing open is not a failure: the
        // payment stays on account. Office reads no allocation and gets no amount back.
        const client = await tx.query<{ code: string }>('select code from client where id = $1', [v.partyId]);
        await tx.query('select public.allocate_to_client($1, $2) as n', [id, client.rows[0]?.code]);
        const sum = await tx.query<{ s: string }>(
          'select coalesce(sum(amount_centimes), 0)::text as s from allocation where instrument_id = $1',
          [id],
        );
        coveredCentimes = Number(sum.rows[0]?.s ?? 0);
      }
      if (v.purchaseCode) {
        // Same for a supplier payment: the oldest open items of that purchase.
        const covered = await tx.query<{ n: number }>(
          v.purchaseCode.startsWith('FF-')
            ? 'select public.allocate_to_supplier_invoice($1, $2) as n'
            : 'select public.allocate_to_purchase($1, $2) as n',
          [id, v.purchaseCode],
        );
        if (!covered.rows[0]?.n) throw new NothingToAllocate();
        const sum = await tx.query<{ s: string }>(
          'select coalesce(sum(amount_centimes), 0)::text as s from allocation where instrument_id = $1',
          [id],
        );
        coveredCentimes = Number(sum.rows[0]?.s ?? 0);
      }
    });
    const effects: Effect[] = [
      { kind: 'document', document: 'payment', code: v.number ?? v.method },
      direction === 'in'
        ? {
            kind: 'payment_in',
            method: v.method,
            amountCentimes: v.amountCentimes,
            cleared: v.method === 'cash',
          }
        : {
            kind: 'payment_out',
            method: v.method,
            amountCentimes: v.amountCentimes,
            cleared: v.method === 'cash',
          },
    ];
    if (v.orderCode && direction === 'in' && coveredCentimes > 0)
      effects.push({ kind: 'receivable_covered', orderCode: v.orderCode, amountCentimes: coveredCentimes });
    if (v.allocateToClient && !v.orderCode && direction === 'in' && coveredCentimes > 0)
      effects.push({ kind: 'receivable_spread', amountCentimes: coveredCentimes });
    if (v.purchaseCode && direction === 'out' && coveredCentimes > 0)
      effects.push({
        kind: 'payable_covered',
        purchaseCode: v.purchaseCode,
        amountCentimes: coveredCentimes,
      });
    return ok({ id, effects: visibleEffects(effects, actor.role) });
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
  try {
    await inRequest(appPool, actor, (tx) => depositInstrumentsIn(tx, actor, parsed.value));
    return ok({ deposited: parsed.value.instrumentIds.length });
  } catch (error) {
    return err(instrumentFailure(error));
  }
}

/**
 * The deposit itself, inside a transaction the caller owns: the rules engine applies an "early deposit" option and
 * records the owner's decision in the same transaction, so one cannot exist without the other. The caller has already
 * checked `instruments.manage` and parsed the input; a failure is thrown for `instrumentFailure` to map.
 */
export async function depositInstrumentsIn(
  tx: pg.PoolClient,
  actor: SessionUser,
  v: DepositInput,
): Promise<void> {
  for (const instrumentId of v.instrumentIds) {
    await insertEvent(tx, actor, { instrumentId, event: 'deposited', date: v.date, accountId: v.accountId });
  }
}

/**
 * A deposited cheque or LCN came back unpaid (law 71.24): the bounce opens a 30-day window to regularize it, takes the
 * instrument off every plan item it covered (negated allocations, so the items are uncovered and overdue when past
 * due), and records the bank's fee as an expense movement when the owner gives it. All in one transaction.
 */
export async function bounceInstrument(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string; regularizationDeadline: string }, InstrumentError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = parseBounceInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const eventId = randomUUID();
  try {
    await inRequest(appPool, actor, async (tx) => {
      await insertEvent(tx, actor, {
        id: eventId,
        instrumentId: v.instrumentId,
        event: 'bounced',
        date: v.date,
      });
      const open = await tx.query<{
        id: string;
        payment_plan_item_id: string;
        amount_centimes: string;
        invoice_id: string | null;
      }>(
        `select a.id, a.payment_plan_item_id, a.amount_centimes::text, a.invoice_id from allocation a
          where a.instrument_id = $1 and a.reverses_id is null
            and not exists (select 1 from allocation r where r.reverses_id = a.id)`,
        [v.instrumentId],
      );
      for (const a of open.rows) {
        await tx.query(
          `insert into allocation (id, instrument_id, payment_plan_item_id, amount_centimes, reverses_id, reason, invoice_id, created_by)
           values ($1, $2, $3, $4, $5, 'chèque ou LCN rejeté', $6, $7)`,
          [
            randomUUID(),
            v.instrumentId,
            a.payment_plan_item_id,
            negateCentimes(centimes(Number(a.amount_centimes))),
            a.id,
            a.invoice_id,
            actor.id,
          ],
        );
      }
      if (v.feeCentimes) {
        const account = await tx.query<{ account: string }>(
          `select money_account_id as account from instrument_event where instrument_id = $1 and event = 'deposited' order by seq desc limit 1`,
          [v.instrumentId],
        );
        await tx.query(
          `insert into money_movement (id, account_id, amount_centimes, movement_date, source, source_id, reason, created_by)
           values ($1, $2, $3, $4, 'expense', $5, 'frais de rejet', $6)`,
          [
            randomUUID(),
            account.rows[0]?.account,
            negateCentimes(centimes(v.feeCentimes)),
            v.date,
            eventId,
            actor.id,
          ],
        );
      }
    });
    return ok({ id: v.instrumentId, regularizationDeadline: regularizationDeadline(v.date) });
  } catch (error) {
    return err(instrumentFailure(error));
  }
}

/** Within the window, a new instrument that covers the bounced one regularizes it (closing the window). */
export async function regularizeInstrument(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<InstrumentRef, InstrumentError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = parseRegularizeInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    await inRequest(appPool, actor, (tx) =>
      insertEvent(tx, actor, {
        instrumentId: v.instrumentId,
        event: 'regularized',
        date: v.date,
        coveringInstrumentId: v.coveringInstrumentId,
      }),
    );
    return ok({ id: v.instrumentId });
  } catch (error) {
    return err(instrumentFailure(error));
  }
}

/** The client contests: the window closes without regularization and the client is flagged (derived from the event). */
export async function disputeInstrument(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<InstrumentRef, InstrumentError>> {
  await require(appPool, actor, 'instruments.manage');
  const parsed = parseDisputeInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  try {
    await inRequest(appPool, actor, (tx) =>
      insertEvent(tx, actor, {
        instrumentId: v.instrumentId,
        event: 'disputed',
        date: v.date,
        reason: v.reason,
      }),
    );
    return ok({ id: v.instrumentId });
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
  /** Set on a bounce: the last day to regularize (law 71.24). */
  regularizationDeadline: string | null;
  coveringInstrumentId: string | null;
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
  /** The client has contested a bounced instrument (derived from a `disputed` event). */
  clientDisputed: boolean;
  state: InstrumentState;
  stateDate: string;
  /** What the instrument has not yet been allocated to (amount minus the allocations, reversals included). */
  unallocatedCentimes: number;
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
  client_disputed: boolean;
  unallocated: string;
  events: {
    event: InstrumentState;
    at_date: string;
    account_id: string | null;
    reason: string | null;
    deadline: string | null;
    covering: string | null;
  }[];
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
                                                 'account_id', e.money_account_id, 'reason', e.reason,
                                                 'deadline', to_char(e.regularization_deadline, 'YYYY-MM-DD'),
                                                 'covering', e.covering_instrument_id) order by e.seq)
                 from instrument_event e where e.instrument_id = i.id) as events,
              (i.amount_centimes - coalesce((select sum(a.amount_centimes) from allocation a where a.instrument_id = i.id), 0))::text as unallocated,
              (i.client_id is not null and exists (
                 select 1 from payment_instrument d join instrument_event de on de.instrument_id = d.id and de.event = 'disputed'
                  where d.client_id = i.client_id)) as client_disputed
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
      regularizationDeadline: e.deadline,
      coveringInstrumentId: e.covering,
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
      clientDisputed: r.client_disputed,
      state: last.event,
      stateDate: last.atDate,
      unallocatedCentimes: Number(r.unallocated),
      events,
    };
  });
}
