import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { centimes } from '@/lib/money';
import { type AccountInput, cashPosition, type InstrumentInput } from './cash-position';

const c = centimes;
const account = (
  id: string,
  opening: number,
  movements: number[],
  asOf: string | null = '2026-01-01',
): AccountInput => ({
  id,
  label: id,
  kind: id.startsWith('cash') ? 'cash' : 'bank',
  openingCentimes: c(opening),
  openingAsOf: asOf,
  movements: movements.map((m) => ({ date: '2026-02-01', amountCentimes: c(m) })),
});
const instr = (
  direction: 'in' | 'out',
  amount: number,
  state: InstrumentInput['state'],
  depositAccountId: string | null = null,
): InstrumentInput => ({ direction, amountCentimes: c(amount), state, depositAccountId });

describe('cashPosition (AC-LED-07)', () => {
  const accounts = [account('cash1', 100_000, [50_000, -20_000]), account('bank1', 1_000_000, [300_000])];
  const instruments = [
    instr('in', 200_000, 'received'),
    instr('in', 400_000, 'deposited', 'bank1'),
    instr('in', 999_999, 'cleared', 'bank1'),
    instr('in', 888_888, 'bounced', 'bank1'),
    instr('in', 777_777, 'cancelled'),
    instr('out', 150_000, 'issued'),
    instr('out', 111_111, 'cleared'),
  ];

  it('real cash = opening balances + movements; total adds the incoming not cleared; outgoing issued is shown apart', () => {
    const p = cashPosition(accounts, instruments);
    expect(p.accounts.map((a) => a.real)).toEqual([130_000, 1_300_000]);
    expect(p.real).toBe(1_430_000);
    expect(p.incomingUncleared).toBe(600_000);
    expect(p.total).toBe(2_030_000);
    expect(p.outgoingUncleared).toBe(150_000);
    expect(p.totalAfterOutgoing).toBe(1_880_000);
  });

  it('one account: its own real cash, and only what was deposited there', () => {
    const p = cashPosition(accounts, instruments, 'bank1');
    expect(p.real).toBe(1_300_000);
    expect(p.incomingUncleared).toBe(400_000);
    expect(p.total).toBe(1_700_000);
    expect(p.outgoingUncleared).toBe(0);
    expect(p.accounts[0]?.incomingDeposited).toBe(400_000);
    expect(cashPosition(accounts, instruments, 'cash1').incomingUncleared).toBe(0);
  });

  it('ignores movements dated on or before the opening balance date, and counts all when there is none', () => {
    const early: AccountInput = {
      ...account('bank2', 10_000, [], '2026-02-01'),
      movements: [
        { date: '2026-02-01', amountCentimes: c(5_000) },
        { date: '2026-02-02', amountCentimes: c(7_000) },
      ],
    };
    expect(cashPosition([early], []).real).toBe(17_000);
    expect(cashPosition([{ ...early, openingAsOf: null, openingCentimes: c(0) }], []).real).toBe(12_000);
  });

  it('a reversal nets a mistaken clearing out', () => {
    expect(cashPosition([account('cash1', 0, [250_000, -250_000])], []).real).toBe(0);
  });

  it('property: total = real + incoming not cleared, for any amounts', () => {
    const state = fc.constantFrom(
      'received',
      'deposited',
      'cleared',
      'bounced',
      'cancelled',
      'issued' as const,
    );
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { maxLength: 10 }),
        fc.array(
          fc.tuple(fc.constantFrom('in', 'out' as const), fc.integer({ min: 1, max: 1_000_000 }), state),
          { maxLength: 10 },
        ),
        (moves, items) => {
          const p = cashPosition(
            [account('bank1', 0, moves)],
            items.map(([d, a, s]) => instr(d as 'in' | 'out', a, s as InstrumentInput['state'])),
          );
          const incoming = items
            .filter(([d, , s]) => d === 'in' && (s === 'received' || s === 'deposited'))
            .reduce((n, [, a]) => n + a, 0);
          return (
            Number(p.total) === Number(p.real) + incoming &&
            Number(p.real) === moves.reduce((n, m) => n + m, 0)
          );
        },
      ),
    );
  });
});
