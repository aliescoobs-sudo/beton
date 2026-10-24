import type pg from 'pg';
import { centimes } from '@/lib/money';
import { inRequest, require, type SessionUser } from '@/modules/platform-security';
import { type CashPosition, cashPosition } from '../domain/cash-position';
import type { InstrumentDirection, InstrumentState } from '../domain/instrument';
import type { AccountKind } from '../domain/money-account';

/**
 * Encaissé (real) and total including uncleared, per account and in total (R9, AC-LED-07). Owner and support only
 * (`cash.read`): office, partner and plant have no read path to the tables underneath either.
 */
export async function getCashPosition(
  appPool: pg.Pool,
  actor: SessionUser,
  accountId?: string,
): Promise<CashPosition> {
  await require(appPool, actor, 'cash.read');
  const data = await inRequest(appPool, actor, async (tx) => {
    const accounts = await tx.query<{
      id: string;
      label: string;
      kind: AccountKind;
      amount: string | null;
      as_of: string | null;
    }>(
      `select a.id, a.label, a.kind, b.amount_centimes::text as amount, to_char(b.as_of, 'YYYY-MM-DD') as as_of
         from money_account a left join opening_balance b on b.account_id = a.id order by (a.kind = 'cash') desc, lower(a.label)`,
    );
    const movements = await tx.query<{ account_id: string; date: string; amount: string }>(
      `select account_id, to_char(movement_date, 'YYYY-MM-DD') as date, amount_centimes::text as amount from money_movement`,
    );
    const instruments = await tx.query<{
      direction: InstrumentDirection;
      amount: string;
      state: InstrumentState;
      deposit_account: string | null;
    }>(
      `select i.direction, i.amount_centimes::text as amount, last.event as state,
              (select e.money_account_id from instrument_event e where e.instrument_id = i.id and e.event = 'deposited'
                order by e.seq desc limit 1) as deposit_account
         from payment_instrument i
         cross join lateral (select e.event from instrument_event e where e.instrument_id = i.id order by e.seq desc limit 1) last`,
    );
    return { accounts: accounts.rows, movements: movements.rows, instruments: instruments.rows };
  });
  return cashPosition(
    data.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      openingCentimes: centimes(Number(a.amount ?? 0)),
      openingAsOf: a.as_of,
      movements: data.movements
        .filter((m) => m.account_id === a.id)
        .map((m) => ({ date: m.date, amountCentimes: centimes(Number(m.amount)) })),
    })),
    data.instruments.map((i) => ({
      direction: i.direction,
      amountCentimes: centimes(Number(i.amount)),
      state: i.state,
      depositAccountId: i.deposit_account,
    })),
    accountId,
  );
}
