import { describe, expect, it } from 'vitest';
import { parseMoneyAccountInput, parseOpeningBalanceInput } from './money-account';

describe('parseMoneyAccountInput', () => {
  it('accepts a caisse and a bank account, normalising spaces', () => {
    expect(parseMoneyAccountInput({ kind: 'cash', label: '  Caisse   centrale ' })).toEqual({
      ok: true,
      value: { kind: 'cash', label: 'Caisse centrale', bankName: null },
    });
    expect(
      parseMoneyAccountInput({ kind: 'bank', label: 'Compte courant', bankName: 'Banque X' }),
    ).toMatchObject({
      ok: true,
    });
  });

  it('refuses a bank account without a bank, an empty label and an unknown kind; drops a bank name on a caisse', () => {
    expect(parseMoneyAccountInput({ kind: 'bank', label: 'A' }).ok).toBe(false);
    expect(parseMoneyAccountInput({ kind: 'cash', label: ' ' }).ok).toBe(false);
    expect(parseMoneyAccountInput({ kind: 'savings', label: 'A' }).ok).toBe(false);
    expect(parseMoneyAccountInput({ kind: 'cash', label: 'A', bankName: 'B' })).toMatchObject({
      ok: true,
      value: { bankName: null },
    });
  });
});

describe('parseOpeningBalanceInput', () => {
  const accountId = '0198a1c0-0000-7000-8000-000000000001';
  it('accepts a whole number of centimes, negative included', () => {
    expect(parseOpeningBalanceInput({ accountId, asOf: '2026-01-01', amountCentimes: -150_000 }).ok).toBe(
      true,
    );
  });
  it('refuses fractions, impossible dates and bad ids', () => {
    expect(parseOpeningBalanceInput({ accountId, asOf: '2026-01-01', amountCentimes: 10.5 }).ok).toBe(false);
    expect(parseOpeningBalanceInput({ accountId, asOf: '2026-02-30', amountCentimes: 1 }).ok).toBe(false);
    expect(parseOpeningBalanceInput({ accountId: 'x', asOf: '2026-01-01', amountCentimes: 1 }).ok).toBe(
      false,
    );
  });
});
