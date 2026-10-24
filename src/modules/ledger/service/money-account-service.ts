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
import { type AccountKind, parseMoneyAccountInput, parseOpeningBalanceInput } from '../domain/money-account';

export type MoneyAccountError = 'INVALID' | 'DUPLICATE' | 'NOT_FOUND';

export interface MoneyAccount {
  id: string;
  kind: AccountKind;
  label: string;
  bankName: string | null;
  opening: { asOf: string; amountCentimes: number; note: string | null } | null;
}

interface Row {
  id: string;
  kind: AccountKind;
  label: string;
  bank_name: string | null;
  as_of: string | null;
  amount_centimes: string | null;
  note: string | null;
}

/** Owner and support read the accounts (the page records the support view). */
export async function listMoneyAccounts(appPool: pg.Pool, actor: SessionUser): Promise<MoneyAccount[]> {
  await require(appPool, actor, 'money_accounts.read');
  const { rows } = await inRequest(appPool, actor, (tx) =>
    tx.query<Row>(
      `select a.id, a.kind, a.label, a.bank_name, to_char(b.as_of, 'YYYY-MM-DD') as as_of,
              b.amount_centimes::text as amount_centimes, b.note
         from money_account a left join opening_balance b on b.account_id = a.id
        order by (a.kind = 'cash') desc, lower(a.label)`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    bankName: r.bank_name,
    opening: r.as_of ? { asOf: r.as_of, amountCentimes: Number(r.amount_centimes), note: r.note } : null,
  }));
}

export async function createMoneyAccount(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, MoneyAccountError>> {
  await require(appPool, actor, 'money_accounts.write');
  const parsed = parseMoneyAccountInput(input);
  if (!parsed.ok) return err('INVALID');
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        `insert into money_account (id, kind, label, bank_name, created_by) values ($1, $2, $3, $4, $5)`,
        [id, parsed.value.kind, parsed.value.label, parsed.value.bankName, actor.id],
      ),
    );
    return ok({ id });
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE');
    throw error;
  }
}

/** Set once per account: a second one is DUPLICATE (a mistake is fixed by a reversing movement, not an edit). */
export async function setOpeningBalance(
  appPool: pg.Pool,
  actor: SessionUser,
  input: unknown,
): Promise<Result<{ id: string }, MoneyAccountError>> {
  await require(appPool, actor, 'money_accounts.write');
  const parsed = parseOpeningBalanceInput(input);
  if (!parsed.ok) return err('INVALID');
  const v = parsed.value;
  const id = randomUUID();
  try {
    await inRequest(appPool, actor, (tx) =>
      tx.query(
        `insert into opening_balance (id, account_id, as_of, amount_centimes, note, created_by) values ($1, $2, $3, $4, $5, $6)`,
        [id, v.accountId, v.asOf, v.amountCentimes, v.note ?? null, actor.id],
      ),
    );
    return ok({ id });
  } catch (error) {
    if (isUniqueViolation(error)) return err('DUPLICATE');
    if (isMalformedId(error) || (error as { code?: string }).code === '23503') return err('NOT_FOUND');
    throw error;
  }
}
