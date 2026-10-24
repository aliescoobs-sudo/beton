import { describe, expect, it } from 'vitest';
import { byDeadline, type Deadline, deadlineStatus } from './deadlines';

describe('deadlineStatus', () => {
  it.each([
    ['2026-10-23', 'overdue'],
    ['2026-10-24', 'due_soon'],
    ['2026-10-31', 'due_soon'],
    ['2026-11-01', 'upcoming'],
  ] as const)('%s on 2026-10-24 is %s', (date, status) => {
    expect(deadlineStatus(date, '2026-10-24')).toBe(status);
  });
});

describe('byDeadline', () => {
  const d = (date: string, documentCode: string): Deadline => ({
    kind: 'payable_due',
    date,
    status: 'upcoming',
    documentCode,
    partyName: 'x',
    amountCentimes: 1,
  });
  it('sorts by date, then by code', () => {
    expect(
      [d('2026-11-02', 'B'), d('2026-11-01', 'Z'), d('2026-11-02', 'A')]
        .sort(byDeadline)
        .map((x) => x.documentCode),
    ).toEqual(['Z', 'A', 'B']);
  });
});
