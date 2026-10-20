import { describe, expect, it } from 'vitest';
import { parseAdvanceInput } from './advance-input';

describe('parseAdvanceInput', () => {
  it('accepts whole days within bounds', () => {
    expect(parseAdvanceInput({ byDays: 3 })).toEqual({ byDays: 3 });
  });

  it.each([0, -1, 1.5, 367, '3', null, NaN])('rejects byDays %s', (byDays) => {
    expect(parseAdvanceInput({ byDays })).toBeNull();
  });

  it('turns a Casablanca date and time into an instant', () => {
    expect(parseAdvanceInput({ toDate: '2026-07-01', toTime: '07:00' })).toEqual({
      to: new Date('2026-07-01T06:00:00Z'),
    });
  });

  it.each([
    ['2026-02-31', '07:00'],
    ['2026-13-45', '07:00'],
    ['2026-2-3', '07:00'],
    ['2026-07-01', '24:00'],
    ['2026-07-01', '7:00'],
    [['2026-07-01'], '07:00'],
    ['2026-07-01', 700],
  ])('rejects %s %s', (toDate, toTime) => {
    expect(parseAdvanceInput({ toDate, toTime })).toBeNull();
  });

  it('rejects non-objects and empty input', () => {
    for (const input of [null, undefined, 'x', 3, {}]) expect(parseAdvanceInput(input)).toBeNull();
  });
});
